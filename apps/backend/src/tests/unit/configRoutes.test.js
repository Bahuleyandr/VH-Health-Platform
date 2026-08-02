import express from 'express';
import request from 'supertest';
import configRoutes, {
  minPatientVersionCodeFromEnv,
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

function makeApp() {
  const app = express();
  app.use('/api/v1/config', configRoutes);
  return app;
}

describe('configRoutes patient app config', () => {
  const originalMinVersionCode = process.env.MIN_PATIENT_VERSION_CODE;
  const originalOutageCommunication = process.env.PATIENT_OUTAGE_COMMUNICATION_JSON;

  afterEach(() => {
    if (originalMinVersionCode === undefined) {
      delete process.env.MIN_PATIENT_VERSION_CODE;
    } else {
      process.env.MIN_PATIENT_VERSION_CODE = originalMinVersionCode;
    }
    if (originalOutageCommunication === undefined) {
      delete process.env.PATIENT_OUTAGE_COMMUNICATION_JSON;
    } else {
      process.env.PATIENT_OUTAGE_COMMUNICATION_JSON = originalOutageCommunication;
    }
  });

  it('returns a disabled minimum patient version code by default', async () => {
    delete process.env.MIN_PATIENT_VERSION_CODE;
    delete process.env.PATIENT_OUTAGE_COMMUNICATION_JSON;

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { min_patient_version_code: 0 }
    });
  });

  it('returns the configured minimum patient version code', async () => {
    process.env.MIN_PATIENT_VERSION_CODE = '42';

    const res = await request(makeApp()).get('/api/v1/config');

    expect(res.status).toBe(200);
    expect(res.body.data.min_patient_version_code).toBe(42);
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
    expect(res.body.data).toEqual({ min_patient_version_code: 0 });
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
});
