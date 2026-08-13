import { spawnSync } from 'child_process';

const node = process.execPath;

function runValidateEnv(extraEnv = {}) {
  return spawnSync(
    node,
    ['--input-type=module', '-e', "import './src/utils/validateEnv.js';"],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_ENV: 'production',
        API_KEY: 'test-api-key',
        DATABASE_URL: 'postgresql://postgres@127.0.0.1:55432/vhhealth_test',
        JWT_SECRET: 'test-jwt-secret-at-least-32-chars',
        FIELD_ENCRYPTION_KEY: 'test-field-encryption-key-32chars!!',
        TOTP_ENCRYPTION_KEY: 'test-totp-encryption-key-32chars!!!!',
        BACKUP_ENCRYPTION_KEY: 'test-backup-encryption-key-32chars!!',
        TENANT_BASE_HOST: 'vhhealth.app',
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );
}

describe('validateEnv signed integration secrets', () => {
  it('allows production boot when HL7 inbound is disabled and its secret is absent', () => {
    const result = runValidateEnv();

    expect(result.status).toBe(0);
  });

  it('fails closed in production when HL7 inbound is enabled without a shared secret', () => {
    const result = runValidateEnv({
      HL7_INBOUND_ENABLED: 'true',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('HL7_INBOUND_SHARED_SECRET');
  });

  it('allows production boot when HL7 signing secret is provisioned and ABDM is disabled', () => {
    const result = runValidateEnv({
      HL7_INBOUND_ENABLED: 'true',
      HL7_INBOUND_SHARED_SECRET: 'test-hl7-inbound-shared-secret-32chars',
      ABDM_ENABLED: 'false',
    });

    expect(result.status).toBe(0);
  });

  it('requires ABDM callback signing secret when ABDM callbacks are enabled', () => {
    const result = runValidateEnv({
      ABDM_ENABLED: 'true',
      ABDM_HIP_ID: 'VH-HIP',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('ABDM_CALLBACK_SECRET');
  });

  // CAN-026: an ABDM-enabled deployment must run with Consent-Manager artefact
  // signature verification ON and a CM public key present, so it can't silently
  // accept unsigned/forged consent artefacts.
  it('requires CM artefact verification + public key when ABDM is enabled', () => {
    const result = runValidateEnv({
      ABDM_ENABLED: 'true',
      ABDM_HIP_ID: 'VH-HIP',
      ABDM_CALLBACK_SECRET: 'test-abdm-callback-shared-secret-32chars',
      // ABDM_VERIFY_CONSENT_ARTEFACT + ABDM_CM_PUBLIC_KEY intentionally omitted.
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toMatch(/ABDM_VERIFY_CONSENT_ARTEFACT|ABDM_CM_PUBLIC_KEY/);
  });

  it('allows ABDM-enabled boot when callback secret + CM artefact verification are provisioned', () => {
    const result = runValidateEnv({
      ABDM_ENABLED: 'true',
      ABDM_HIP_ID: 'VH-HIP',
      ABDM_CALLBACK_SECRET: 'test-abdm-callback-shared-secret-32chars',
      ABDM_VERIFY_CONSENT_ARTEFACT: 'true',
      ABDM_CM_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nMIIBdummytestkey\n-----END PUBLIC KEY-----',
    });

    expect(result.status).toBe(0);
  });
});

describe('validateEnv Redis Sentinel production contract', () => {
  it('fails closed when Sentinel is required without explicit hosts and credentials', () => {
    const result = runValidateEnv({ REDIS_REQUIRE_SENTINEL: 'true' });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('REDIS_SENTINEL_HOSTS');
    expect(`${result.stdout}${result.stderr}`).toContain('REDIS_PASSWORD');
    expect(`${result.stdout}${result.stderr}`).toContain('REDIS_SENTINEL_PASSWORD');
  });

  it('accepts the complete three-Sentinel production contract', () => {
    const result = runValidateEnv({
      REDIS_REQUIRE_SENTINEL: 'true',
      REDIS_SENTINEL_HOSTS: 'redis-0.example:26379,redis-1.example:26379,redis-2.example:26379',
      REDIS_SENTINEL_MASTER: 'vhhealth-primary',
      REDIS_PASSWORD: 'data-password-at-least-16-chars',
      REDIS_SENTINEL_PASSWORD: 'sentinel-password-at-least-16-chars',
    });

    expect(result.status).toBe(0);
  });

  it('rejects a standalone URL when Sentinel is required', () => {
    const result = runValidateEnv({
      REDIS_REQUIRE_SENTINEL: 'true',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_SENTINEL_HOSTS: 'redis-0.example:26379,redis-1.example:26379,redis-2.example:26379',
      REDIS_SENTINEL_MASTER: 'vhhealth-primary',
      REDIS_PASSWORD: 'data-password-at-least-16-chars',
      REDIS_SENTINEL_PASSWORD: 'sentinel-password-at-least-16-chars',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('REDIS_URL');
  });
});

describe('validateEnv NHCX inert feature flag', () => {
  it('defaults to off and does not require live NHCX credentials at boot', () => {
    const result = runValidateEnv();

    expect(result.status).toBe(0);
  });

  it('allows NHCX_ENABLED=true without live credentials because tenant credentials are DB-backed', () => {
    const result = runValidateEnv({ NHCX_ENABLED: 'true' });

    expect(result.status).toBe(0);
  });
});

// Item 4 (auth-hygiene audit §5): the dev-OTP opt-in must fail closed in prod.
describe('validateEnv dev-OTP opt-in', () => {
  it('fails closed in production when ALLOW_DEV_OTP=true', () => {
    const result = runValidateEnv({ ALLOW_DEV_OTP: 'true' });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('ALLOW_DEV_OTP');
  });

  it('allows production boot when ALLOW_DEV_OTP=false', () => {
    const result = runValidateEnv({ ALLOW_DEV_OTP: 'false' });

    expect(result.status).toBe(0);
  });

  it('allows production boot when ALLOW_DEV_OTP is unset', () => {
    const result = runValidateEnv();

    expect(result.status).toBe(0);
  });
});

// W3-H2 (audit 2026-06-22): per-tenant subdomain routing must not silently fall
// back to the localhost default (→ DEFAULT tenant cross-tenant exposure).
describe('validateEnv TENANT_BASE_HOST', () => {
  it('fails closed in production when TENANT_BASE_HOST is unset/empty', () => {
    const result = runValidateEnv({ TENANT_BASE_HOST: '' });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('TENANT_BASE_HOST');
  });

  it('fails closed in production when TENANT_BASE_HOST is "localhost"', () => {
    const result = runValidateEnv({ TENANT_BASE_HOST: 'localhost' });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('TENANT_BASE_HOST');
  });

  it('allows production boot with a real TENANT_BASE_HOST', () => {
    const result = runValidateEnv({ TENANT_BASE_HOST: 'vhhealth.app' });

    expect(result.status).toBe(0);
  });
});
