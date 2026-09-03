// Regression test for finding
// 2026-05-22-pediatric-opd-receptionist-69db0787.
//
// `POST /api/v1/appointments/walkin` accepted a minor (<18) walk-in
// registration that carried `guardian_name` + `guardian_phone` +
// `guardian_relationship` but no `guardian_id_type` / `guardian_id`
// — the chart's legal-consent contact was unverifiable, breaking
// IRDAI cashless-claim KYC, MLC paperwork (when the minor escalates
// to ER), and the discharge-handover contact check.
//
// The fix requires either:
//   * `guardian_id_type` (aadhaar / pan / voter_id / passport / etc.)
//     AND `guardian_id` (the reference number / masked ref), OR
//   * `guardian_user_id` linking to an existing adult users row that
//     already carries a verified legal ID.
// Otherwise the controller returns 400 with code
// `MINOR_GUARDIAN_ID_REQUIRED`.
//
// Adult walk-ins are unaffected; the guard only fires when DOB
// indicates <18.

import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken, ensureTestIdentity } from './testClient.js';

const RECEPTIONIST_UID = 'f1234567-aaaa-4bbb-8ccc-dddddddd0001';
const receptionistToken = generateTestToken('RECEPTIONIST', {
  uid: RECEPTIONIST_UID, id: 9_700_001,
});

// DOB ~5y ago — definitively a minor.
const MINOR_BIRTHDAY = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
})();
// DOB ~30y ago — definitively an adult.
const ADULT_BIRTHDAY = (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 30);
  return d.toISOString().slice(0, 10);
})();

const baseBody = {
  patient_name: 'Test Minor',
  patient_phone: '9000770001',
  patient_birthday: MINOR_BIRTHDAY,
  patient_gender: 'M',
  reason: 'Fever',
  guardian_name: 'Test Guardian',
  guardian_phone: '9000770002',
  guardian_relationship: 'mother',
};

describe('POST /appointments/walkin — minor guardian legal-ID gate (D74)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity(RECEPTIONIST_UID);
  });
  it('rejects a minor walk-in without guardian_id_type / guardian_id (MINOR_GUARDIAN_ID_REQUIRED)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({ ...baseBody });

    expect(res.statusCode).toBe(400);
    expect(res.body?.code === 'MINOR_GUARDIAN_ID_REQUIRED'
      || res.body?.details?.code === 'MINOR_GUARDIAN_ID_REQUIRED').toBe(true);
    expect(String(res.body?.message || '')).toMatch(/Minor.*guardian legal ID/i);
  });

  it('rejects when only guardian_id_type is set (legal ID requires both type AND ref)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({ ...baseBody, guardian_id_type: 'aadhaar' });
    expect(res.statusCode).toBe(400);
    expect(res.body?.code === 'MINOR_GUARDIAN_ID_REQUIRED'
      || res.body?.details?.code === 'MINOR_GUARDIAN_ID_REQUIRED').toBe(true);
  });

  it('rejects when only guardian_id is set (legal ID requires both type AND ref)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({ ...baseBody, guardian_id: '9999-0000-1234' });
    expect(res.statusCode).toBe(400);
    expect(res.body?.code === 'MINOR_GUARDIAN_ID_REQUIRED'
      || res.body?.details?.code === 'MINOR_GUARDIAN_ID_REQUIRED').toBe(true);
  });

  it('accepts an adult walk-in even without guardian legal ID', async () => {
    // We don't care about the downstream success path here — the gate
    // we're testing must NOT fire for an adult DOB. Any non-400 (or a
    // 400 whose code is anything other than MINOR_GUARDIAN_ID_REQUIRED)
    // is fine: the gate didn't intercept.
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({
        patient_name: 'Test Adult',
        patient_phone: '9000770003',
        patient_birthday: ADULT_BIRTHDAY,
        patient_gender: 'F',
        reason: 'Cough',
      });
    if (res.statusCode === 400) {
      expect(res.body?.code).not.toBe('MINOR_GUARDIAN_ID_REQUIRED');
      expect(res.body?.details?.code).not.toBe('MINOR_GUARDIAN_ID_REQUIRED');
    }
  });

  it('passes the gate when guardian_user_id is supplied (existing adult carries the legal ID)', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({ ...baseBody, guardian_user_id: 42 });
    if (res.statusCode === 400) {
      expect(res.body?.code).not.toBe('MINOR_GUARDIAN_ID_REQUIRED');
      expect(res.body?.details?.code).not.toBe('MINOR_GUARDIAN_ID_REQUIRED');
    }
  });

  it('passes the gate when both guardian_id_type and guardian_id are supplied', async () => {
    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${receptionistToken}`)
      .send({
        ...baseBody,
        guardian_id_type: 'aadhaar',
        guardian_id: 'XXXX-XXXX-1234',
      });
    if (res.statusCode === 400) {
      expect(res.body?.code).not.toBe('MINOR_GUARDIAN_ID_REQUIRED');
      expect(res.body?.details?.code).not.toBe('MINOR_GUARDIAN_ID_REQUIRED');
    }
  });
});
