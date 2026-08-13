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

describe('validateEnv CARE_TEAM_ENFORCEMENT_MODE', () => {
  it.each(['off', 'shadow', 'enforce'])('accepts the governed mode %s', (mode) => {
    expect(validate({ CARE_TEAM_ENFORCEMENT_MODE: mode }).error).toBeUndefined();
  });

  it('rejects an invalid or empty explicit mode', () => {
    expect(validate({ CARE_TEAM_ENFORCEMENT_MODE: 'observe' }).error?.details[0].message)
      .toContain('CARE_TEAM_ENFORCEMENT_MODE');
    expect(validate({ CARE_TEAM_ENFORCEMENT_MODE: '' }).error?.details[0].message)
      .toContain('CARE_TEAM_ENFORCEMENT_MODE');
  });
});

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

describe('validateEnv PATIENT_OUTAGE_COMMUNICATION_JSON', () => {
  it('is optional and accepts a bounded operator JSON string', () => {
    expect(validate().error).toBeUndefined();
    expect(validate({ PATIENT_OUTAGE_COMMUNICATION_JSON: '{"revision":1}' }).error).toBeUndefined();
  });

  it('rejects an oversized operator value before route parsing', () => {
    const result = validate({ PATIENT_OUTAGE_COMMUNICATION_JSON: 'x'.repeat(16 * 1024 + 1) });

    expect(result.error?.details[0].message).toContain('PATIENT_OUTAGE_COMMUNICATION_JSON');
  });
});

describe('validateEnv Firebase App Check report mode', () => {
  it('keeps App Check off without requiring app-ID lists', () => {
    const { error, value } = validate();

    expect(error).toBeUndefined();
    expect(value.APP_CHECK_MODE).toBe('off');
  });

  it('requires both client app-ID lists in report mode', () => {
    const missing = validate({ APP_CHECK_MODE: 'report' });
    const patientOnly = validate({
      APP_CHECK_MODE: 'report',
      FIREBASE_APP_CHECK_PATIENT_APP_IDS: 'patient-app-id',
    });

    expect(missing.error?.details.map(detail => detail.context?.label)).toEqual(
      expect.arrayContaining([
        'FIREBASE_APP_CHECK_PATIENT_APP_IDS',
        'FIREBASE_APP_CHECK_STAFF_APP_IDS',
      ]),
    );
    expect(patientOnly.error?.details[0].context?.label).toBe('FIREBASE_APP_CHECK_STAFF_APP_IDS');
  });

  it('accepts report mode with comma-separated exact app IDs', () => {
    const result = validate({
      APP_CHECK_MODE: 'report',
      FIREBASE_APP_CHECK_PATIENT_APP_IDS: 'patient-android,patient-ios',
      FIREBASE_APP_CHECK_STAFF_APP_IDS: 'staff-android,staff-ios,staff-web',
    });

    expect(result.error).toBeUndefined();
  });

  it('rejects the unimplemented enforce mode', () => {
    expect(validate({ APP_CHECK_MODE: 'enforce' }).error?.details[0].message).toContain(
      'APP_CHECK_MODE',
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
      DOWNTIME_MIRROR_DIR: ''
    });
    const configured = validate({
      CLINICAL_CONTINUITY_PACKS_ENABLED: 'true',
      DOWNTIME_MIRROR_DIR: 'D:\\continuity-packs'
    });

    expect(
      missing.error?.details.some(detail => detail.context?.label === 'DOWNTIME_MIRROR_DIR')
    ).toBe(true);
    expect(configured.error).toBeUndefined();
  });
});

describe('validateEnv clinical continuity action-registry gate', () => {
  it('defaults C4.2 enforcement to inert', () => {
    const { error, value } = validate();

    expect(error).toBeUndefined();
    expect(value.CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED).toBe('false');
  });

  it('accepts only explicit true or false strings', () => {
    expect(validate({ CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED: 'true' }).error).toBeUndefined();
    expect(validate({ CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED: '1' }).error).toBeDefined();
  });
});
