import express from 'express';
import request from 'supertest';
import configRoutes, {
  minPatientVersionCodeFromEnv,
  minStaffVersionCodeFromEnv,
  patientMinimumVersionPolicyFromEnv,
  patientOutageCommunicationFromEnv
} from '../../routes/configRoutes.js';

const messages = Object.fromEntries(
  ['en', 'hi', 'ta', 'te', 'ml'].map(locale => [
    locale,
    `${locale} approved copy [facility contact number]`
  ])
);

const outageCommunication = {
  revision: 7,
  messages,
  facility_contact_number: '+91 44 4511 4511'
};

const minimumVersionPolicy = {
  algorithm: 'Ed25519',
  format: 'vhhealth_patient_minimum_version/v1',
  key_id: 'patient-min-version-2026-01',
  policy: {
    audience: 'vhhealth-patient-minimum-version',
    tenant_id: '00000000-0000-4000-8000-000000000001',
    revision: 8,
    min_patient_version_code: 42,
    issued_at: '2026-08-13T00:00:00.000Z',
    grace_until: '2026-08-15T00:00:00.000Z'
  },
  signature: Buffer.alloc(64, 7).toString('base64')
};

function makeApp({ tenantId } = {}) {
  const app = express();
  if (tenantId !== undefined) {
    app.use((req, _res, next) => {
      req.tenantId = tenantId;
      next();
    });
  }
  app.use('/api/v1/config', configRoutes);
  return app;
}

describe('configRoutes patient app config', () => {
  const originalMinVersionCode = process.env.MIN_PATIENT_VERSION_CODE;
  const originalMinStaffVersionCode = process.env.MIN_STAFF_VERSION_CODE;
  const originalOutageCommunication = process.env.PATIENT_OUTAGE_COMMUNICATION_JSON;
  const originalMinimumVersionPolicy = process.env.PATIENT_MINIMUM_VERSION_POLICY_JSON;

  beforeEach(() => {
    delete process.env.MIN_PATIENT_VERSION_CODE;
    delete process.env.MIN_STAFF_VERSION_CODE;
    delete process.env.PATIENT_OUTAGE_COMMUNICATION_JSON;
    delete process.env.PATIENT_MINIMUM_VERSION_POLICY_JSON;
  });

  afterEach(() => {
    if (originalMinVersionCode === undefined) {
      delete process.env.MIN_PATIENT_VERSION_CODE;
    } else {
      process.env.MIN_PATIENT_VERSION_CODE = originalMinVersionCode;
    }
    if (originalMinStaffVersionCode === undefined) {
      delete process.env.MIN_STAFF_VERSION_CODE;
    } else {
      process.env.MIN_STAFF_VERSION_CODE = originalMinStaffVersionCode;
    }
    if (originalOutageCommunication === undefined) {
      delete process.env.PATIENT_OUTAGE_COMMUNICATION_JSON;
    } else {
      process.env.PATIENT_OUTAGE_COMMUNICATION_JSON = originalOutageCommunication;
    }
    if (originalMinimumVersionPolicy === undefined) {
      delete process.env.PATIENT_MINIMUM_VERSION_POLICY_JSON;
    } else {
      process.env.PATIENT_MINIMUM_VERSION_POLICY_JSON = originalMinimumVersionPolicy;
    }
  });

  it('returns a disabled minimum patient version code by default', async () => {
    delete process.env.MIN_PATIENT_VERSION_CODE;
    delete process.env.PATIENT_OUTAGE_COMMUNICATION_JSON;

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { min_patient_version_code: 0, min_staff_version_code: 0 }
    });
  });

  it('returns the configured minimum patient version code', async () => {
    process.env.MIN_PATIENT_VERSION_CODE = '42';

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data.min_patient_version_code).toBe(42);
  });

  it('returns the configured minimum staff version code independently', async () => {
    process.env.MIN_STAFF_VERSION_CODE = '17';

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      min_patient_version_code: 0,
      min_staff_version_code: 17
    });
  });

  it('forwards a bounded pre-signed policy and derives the legacy projection', async () => {
    process.env.MIN_PATIENT_VERSION_CODE = '7';
    process.env.PATIENT_MINIMUM_VERSION_POLICY_JSON = JSON.stringify(minimumVersionPolicy);

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      min_patient_version_code: 42,
      min_staff_version_code: 0,
      minimum_version_policy: minimumVersionPolicy
    });
  });

  it('does not forward another tenant policy on the bare default host', async () => {
    process.env.MIN_PATIENT_VERSION_CODE = '7';
    process.env.PATIENT_MINIMUM_VERSION_POLICY_JSON = JSON.stringify({
      ...minimumVersionPolicy,
      policy: {
        ...minimumVersionPolicy.policy,
        tenant_id: '00000000-0000-4000-8000-000000000099'
      }
    });

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      min_patient_version_code: 7,
      min_staff_version_code: 0
    });
  });

  it('binds a resolved API client tenant before forwarding the policy', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000099';
    const tenantPolicy = {
      ...minimumVersionPolicy,
      policy: { ...minimumVersionPolicy.policy, tenant_id: tenantId }
    };
    process.env.PATIENT_MINIMUM_VERSION_POLICY_JSON = JSON.stringify(tenantPolicy);

    const res = await request(makeApp({ tenantId })).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data.minimum_version_policy).toEqual(tenantPolicy);
  });

  it.each([
    ['extra envelope field', { ...minimumVersionPolicy, signing_secret: 'no' }],
    [
      'wrong audience',
      {
        ...minimumVersionPolicy,
        policy: { ...minimumVersionPolicy.policy, audience: 'another-app' }
      }
    ],
    [
      'grace exceeds seven days',
      {
        ...minimumVersionPolicy,
        policy: {
          ...minimumVersionPolicy.policy,
          grace_until: '2026-08-21T00:00:00.001Z'
        }
      }
    ],
    ['non-canonical signature', { ...minimumVersionPolicy, signature: 'not-base64' }]
  ])('omits invalid minimum-version policy: %s', async (_label, candidate) => {
    process.env.MIN_PATIENT_VERSION_POLICY_JSON = JSON.stringify(candidate);

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      min_patient_version_code: 0,
      min_staff_version_code: 0
    });
  });

  it('rejects a signed policy for a different resolved tenant', () => {
    expect(
      patientMinimumVersionPolicyFromEnv(
        JSON.stringify(minimumVersionPolicy),
        '00000000-0000-4000-8000-000000000099'
      )
    ).toBeNull();
  });

  it('returns only the bounded operational-copy fields when configured', async () => {
    process.env.PATIENT_OUTAGE_COMMUNICATION_JSON = JSON.stringify(outageCommunication);

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data.outage_communication).toEqual(outageCommunication);
    expect(Object.keys(res.body.data.outage_communication).sort()).toEqual([
      'facility_contact_number',
      'messages',
      'revision'
    ]);
  });

  it.each([
    ['extra top-level field', { ...outageCommunication, policy: { enabled: true } }],
    ['extra locale', { ...outageCommunication, messages: { ...messages, fr: 'extra' } }],
    ['missing locale', { ...outageCommunication, messages: { ...messages, ml: undefined } }],
    ['invalid revision', { ...outageCommunication, revision: 0 }],
    [
      'missing contact token',
      { ...outageCommunication, messages: { ...messages, en: 'no token' } }
    ],
    ['invalid contact', { ...outageCommunication, facility_contact_number: 'javascript:alert(1)' }]
  ])('omits invalid outage communication: %s', async (_label, candidate) => {
    process.env.PATIENT_OUTAGE_COMMUNICATION_JSON = JSON.stringify(candidate);

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      min_patient_version_code: 0,
      min_staff_version_code: 0
    });
  });

  it('parses a valid operator record without adding defaults', () => {
    expect(patientOutageCommunicationFromEnv(JSON.stringify(outageCommunication))).toEqual(
      outageCommunication
    );
    expect(patientOutageCommunicationFromEnv('not-json')).toBeNull();
  });

  it('fails safe to disabled for malformed runtime values', () => {
    expect(minPatientVersionCodeFromEnv('not-a-number')).toBe(0);
    expect(minPatientVersionCodeFromEnv('-1')).toBe(0);
    expect(minPatientVersionCodeFromEnv('1.5')).toBe(0);
    expect(minPatientVersionCodeFromEnv('3')).toBe(3);
  });

  it('fails safe to disabled for malformed staff runtime values', () => {
    expect(minStaffVersionCodeFromEnv('not-a-number')).toBe(0);
    expect(minStaffVersionCodeFromEnv('-1')).toBe(0);
    expect(minStaffVersionCodeFromEnv('1.5')).toBe(0);
    expect(minStaffVersionCodeFromEnv('3')).toBe(3);
  });
});
