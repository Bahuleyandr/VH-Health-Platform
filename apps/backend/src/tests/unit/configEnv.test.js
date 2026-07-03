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
