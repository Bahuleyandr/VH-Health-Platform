// ABDM consent-artefact verification env gate (CAN-026).
//
// When ABDM_ENABLED=true, the deployment MUST set ABDM_VERIFY_CONSENT_ARTEFACT=
// true and ABDM_CM_PUBLIC_KEY so it can't silently accept unsigned/forged
// consent artefacts. Tests the exported Joi schema directly.
import { envSchema } from '../../utils/validateEnv.js';

function messages(env) {
  const { error } = envSchema.validate(env, { abortEarly: false });
  return (error?.details || []).map((d) => d.message).join(' | ');
}

const BASE_ABDM = {
  ABDM_ENABLED: 'true',
  ABDM_HIP_ID: 'hip-123',
  ABDM_CALLBACK_SECRET: 'x'.repeat(64),
};

describe('ABDM artefact verification env gate (CAN-026)', () => {
  it('requires ABDM_VERIFY_CONSENT_ARTEFACT when ABDM is enabled', () => {
    expect(messages({ ...BASE_ABDM, ABDM_CM_PUBLIC_KEY: 'pk' }))
      .toMatch(/ABDM_VERIFY_CONSENT_ARTEFACT/);
  });

  it('rejects ABDM_VERIFY_CONSENT_ARTEFACT=false when ABDM is enabled', () => {
    expect(messages({ ...BASE_ABDM, ABDM_VERIFY_CONSENT_ARTEFACT: 'false', ABDM_CM_PUBLIC_KEY: 'pk' }))
      .toMatch(/ABDM_VERIFY_CONSENT_ARTEFACT/);
  });

  it('requires ABDM_CM_PUBLIC_KEY when ABDM is enabled', () => {
    expect(messages({ ...BASE_ABDM, ABDM_VERIFY_CONSENT_ARTEFACT: 'true' }))
      .toMatch(/ABDM_CM_PUBLIC_KEY/);
  });

  it('accepts a complete ABDM config', () => {
    expect(messages({ ...BASE_ABDM, ABDM_VERIFY_CONSENT_ARTEFACT: 'true', ABDM_CM_PUBLIC_KEY: 'pk' }))
      .not.toMatch(/ABDM_VERIFY_CONSENT_ARTEFACT|ABDM_CM_PUBLIC_KEY/);
  });

  it('does not require them when ABDM is disabled', () => {
    expect(messages({ ABDM_ENABLED: 'false' }))
      .not.toMatch(/ABDM_VERIFY_CONSENT_ARTEFACT|ABDM_CM_PUBLIC_KEY/);
  });
});
