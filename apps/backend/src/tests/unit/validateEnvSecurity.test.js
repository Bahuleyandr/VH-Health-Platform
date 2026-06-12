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

  it('allows ABDM-enabled boot when callback HIP id and signing secret are provisioned', () => {
    const result = runValidateEnv({
      ABDM_ENABLED: 'true',
      ABDM_HIP_ID: 'VH-HIP',
      ABDM_CALLBACK_SECRET: 'test-abdm-callback-shared-secret-32chars',
    });

    expect(result.status).toBe(0);
  });
});
