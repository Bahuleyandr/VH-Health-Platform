import { envSchema } from '../../utils/validateEnv.js';

const BASE_ENV = {
  NODE_ENV: 'production',
  API_KEY: 'test-api-key',
  DATABASE_URL: 'postgresql://postgres@127.0.0.1:55432/vhhealth_test',
  JWT_SECRET: 'test-jwt-secret-at-least-32-chars',
  FIELD_ENCRYPTION_KEY: 'test-field-encryption-key-32chars!!',
  TOTP_ENCRYPTION_KEY: 'test-totp-encryption-key-32chars!!!!',
  BACKUP_ENCRYPTION_KEY: 'test-backup-encryption-key-32chars!!',
  TENANT_BASE_HOST: 'vhhealth.app'
};

function validate(extraEnv = {}) {
  return envSchema.validate({ ...BASE_ENV, ...extraEnv }, { abortEarly: false });
}

describe('validateEnv MIN_PATIENT_VERSION_CODE', () => {
  it('defaults the patient hard-upgrade gate to disabled', () => {
    const { error, value } = validate();

    expect(error).toBeUndefined();
    expect(value.MIN_PATIENT_VERSION_CODE).toBe(0);
  });

  it('accepts a non-negative integer build code', () => {
    const { error, value } = validate({ MIN_PATIENT_VERSION_CODE: '7' });

    expect(error).toBeUndefined();
    expect(value.MIN_PATIENT_VERSION_CODE).toBe(7);
  });

  it('rejects negative or fractional build codes', () => {
    expect(validate({ MIN_PATIENT_VERSION_CODE: '-1' }).error?.details[0].message).toContain(
      'MIN_PATIENT_VERSION_CODE'
    );
    expect(validate({ MIN_PATIENT_VERSION_CODE: '1.5' }).error?.details[0].message).toContain(
      'MIN_PATIENT_VERSION_CODE'
    );
  });
});

describe('validateEnv clinical continuity publication gate', () => {
  it('defaults the C3.1 writer to inert without requiring a mirror root', () => {
    const { error, value } = validate();

    expect(error).toBeUndefined();
    expect(value.CLINICAL_CONTINUITY_PACKS_ENABLED).toBe('false');
  });

  it('requires an explicit publication root only when the C3.1 writer is enabled', () => {
    const missing = validate({
      CLINICAL_CONTINUITY_PACKS_ENABLED: 'true',
      DOWNTIME_MIRROR_DIR: '',
    });
    const configured = validate({
      CLINICAL_CONTINUITY_PACKS_ENABLED: 'true',
      DOWNTIME_MIRROR_DIR: 'D:\\continuity-packs',
    });

    expect(missing.error?.details.some(
      (detail) => detail.context?.label === 'DOWNTIME_MIRROR_DIR',
    )).toBe(true);
    expect(configured.error).toBeUndefined();
  });
});
