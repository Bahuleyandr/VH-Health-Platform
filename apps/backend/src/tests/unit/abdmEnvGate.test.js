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

const VERIFIED_ABDM = {
  ...BASE_ABDM,
  ABDM_VERIFY_CONSENT_ARTEFACT: 'true',
  ABDM_CM_PUBLIC_KEY: 'pk',
};

const PRODUCTION_URLS = {
  ABDM_GATEWAY_URL: 'https://gateway.abdm.gov.in/gateway',
  ABDM_BRIDGE_URL: 'https://bridge.abdm.gov.in/v1',
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

describe('ABHA enrolment environment binding', () => {
  it('requires an explicit enrolment base URL in production', () => {
    expect(messages({
      ...VERIFIED_ABDM,
      ABDM_ENVIRONMENT: 'production',
      ABDM_CM_ID: 'prod-cm',
      ...PRODUCTION_URLS,
    })).toMatch(/ABHA_ENROLMENT_BASE_URL/);
  });

  it('rejects the sandbox enrolment host in production', () => {
    expect(messages({
      ...VERIFIED_ABDM,
      ABDM_ENVIRONMENT: 'production',
      ABDM_CM_ID: 'prod-cm',
      ...PRODUCTION_URLS,
      ABHA_ENROLMENT_BASE_URL: 'https://ABHASBX.ABDM.GOV.IN:443/alternate/path',
    })).toMatch(/ABHA_ENROLMENT_BASE_URL/);
  });

  it('accepts an explicit non-sandbox HTTPS enrolment host in production', () => {
    expect(messages({
      ...VERIFIED_ABDM,
      ABDM_ENVIRONMENT: 'production',
      ABDM_CM_ID: 'prod-cm',
      ABHA_ENROLMENT_BASE_URL: 'https://abha.abdm.gov.in/abha/api/v3',
      ...PRODUCTION_URLS,
    })).not.toMatch(/ABDM_ENVIRONMENT|ABDM_CM_ID|ABHA_ENROLMENT_BASE_URL/);
  });

  it('requires explicit production gateway and bridge URLs', () => {
    const result = messages({
      ...VERIFIED_ABDM,
      ABDM_ENVIRONMENT: 'production',
      ABDM_CM_ID: 'prod-cm',
      ABHA_ENROLMENT_BASE_URL: 'https://abha.abdm.gov.in/abha/api/v3',
    });
    expect(result).toMatch(/ABDM_GATEWAY_URL/);
    expect(result).toMatch(/ABDM_BRIDGE_URL/);
  });

  it.each([
    ['ABDM_GATEWAY_URL', 'http://gateway.abdm.gov.in/gateway'],
    ['ABDM_GATEWAY_URL', 'https://dev.abdm.gov.in/gateway'],
    ['ABDM_BRIDGE_URL', 'https://sandbox.bridge.example/v1'],
    ['ABDM_BRIDGE_URL', 'https://127.0.0.1/v1'],
    ['ABDM_BRIDGE_URL', 'https://[::1]/v1'],
  ])('rejects non-production-safe %s values', (key, value) => {
    expect(messages({
      ...VERIFIED_ABDM,
      ABDM_ENVIRONMENT: 'production',
      ABDM_CM_ID: 'prod-cm',
      ABHA_ENROLMENT_BASE_URL: 'https://abha.abdm.gov.in/abha/api/v3',
      ...PRODUCTION_URLS,
      [key]: value,
    })).toMatch(new RegExp(key));
  });

  it('retains the sandbox default outside production', () => {
    const { error, value } = envSchema.validate({
      ...VERIFIED_ABDM,
      ABDM_ENVIRONMENT: 'sandbox',
    }, { abortEarly: false });

    expect((error?.details || []).map((detail) => detail.message).join(' | '))
      .not.toMatch(/ABDM_ENVIRONMENT|ABDM_CM_ID|ABHA_ENROLMENT_BASE_URL/);
    expect(value.ABHA_ENROLMENT_BASE_URL).toBe('https://abhasbx.abdm.gov.in/abha/api/v3');
    expect(value.ABDM_GATEWAY_URL).toBe('https://dev.abdm.gov.in/gateway');
    expect(value.ABDM_BRIDGE_URL).toBe('https://dev.abdm.gov.in/devservice/v1');
  });
});
