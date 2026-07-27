import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
  isPathwayProjectorShadowEnabled,
} from '../../config/pathwayProjectorConfig.js';
import { envSchema } from '../../utils/validateEnv.js';

const BASE_ENV = {
  NODE_ENV: 'production',
  API_KEY: 'test-api-key',
  DATABASE_URL: 'postgresql://postgres@127.0.0.1:55432/vhhealth_test',
  JWT_SECRET: 'test-jwt-secret-at-least-32-chars',
  FIELD_ENCRYPTION_KEY: 'test-field-encryption-key-32chars!!',
  TOTP_ENCRYPTION_KEY: 'test-totp-encryption-key-32chars!!!!',
  BACKUP_ENCRYPTION_KEY: 'test-backup-encryption-key-32chars!!',
  TENANT_BASE_HOST: 'vhhealth.app',
};

function validate(extraEnv = {}) {
  return envSchema.validate({ ...BASE_ENV, ...extraEnv }, { abortEarly: false });
}

describe('Pathway projector configuration', () => {
  it('keeps the consumer identity and generation in one stable config module', () => {
    expect(PATHWAY_PROJECTOR_CONSUMER_KEY).toBe('care_pathway_projector');
    expect(PATHWAY_PROJECTOR_GENERATION).toBe(5);
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['true', true],
    ['TRUE', true],
    [' true ', true],
  ])('resolves PATHWAY_PROJECTOR_SHADOW_ENABLED=%p as %p', (value, expected) => {
    expect(isPathwayProjectorShadowEnabled({
      PATHWAY_PROJECTOR_SHADOW_ENABLED: value,
    })).toBe(expected);
  });

  it('defaults the validated deployment flag to false', () => {
    const { error, value } = validate();

    expect(error).toBeUndefined();
    expect(value.PATHWAY_PROJECTOR_SHADOW_ENABLED).toBe('false');
  });

  it.each(['true', 'false'])('accepts the exact deployment value %s', (flag) => {
    const { error, value } = validate({ PATHWAY_PROJECTOR_SHADOW_ENABLED: flag });

    expect(error).toBeUndefined();
    expect(value.PATHWAY_PROJECTOR_SHADOW_ENABLED).toBe(flag);
  });

  it.each(['', 'TRUE', 'False', 'yes', '1'])('rejects the non-canonical deployment value %p', (flag) => {
    const { error } = validate({ PATHWAY_PROJECTOR_SHADOW_ENABLED: flag });

    expect(error?.details.some((detail) => detail.context?.key === 'PATHWAY_PROJECTOR_SHADOW_ENABLED'))
      .toBe(true);
  });
});
