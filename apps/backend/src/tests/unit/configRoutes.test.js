import express from 'express';
import request from 'supertest';
import configRoutes, { minPatientVersionCodeFromEnv } from '../../routes/configRoutes.js';

function makeApp() {
  const app = express();
  app.use('/api/v1/config', configRoutes);
  return app;
}

describe('configRoutes patient app config', () => {
  const originalMinVersionCode = process.env.MIN_PATIENT_VERSION_CODE;

  afterEach(() => {
    if (originalMinVersionCode === undefined) {
      delete process.env.MIN_PATIENT_VERSION_CODE;
    } else {
      process.env.MIN_PATIENT_VERSION_CODE = originalMinVersionCode;
    }
  });

  it('returns a disabled minimum patient version code by default', async () => {
    delete process.env.MIN_PATIENT_VERSION_CODE;

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

  it('fails safe to disabled for malformed runtime values', () => {
    expect(minPatientVersionCodeFromEnv('not-a-number')).toBe(0);
    expect(minPatientVersionCodeFromEnv('-1')).toBe(0);
    expect(minPatientVersionCodeFromEnv('1.5')).toBe(0);
    expect(minPatientVersionCodeFromEnv('3')).toBe(3);
  });
});
