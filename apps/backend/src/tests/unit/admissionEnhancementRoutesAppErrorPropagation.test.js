import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the shared relayAppError port
// (mirrors paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// admissionEnhancementRoutes.js carries three identical isOperational guards
// (R6) whose non-operational tail is a locally-logged hand-written generic
// 500. The port relays only the operational branch through relayAppError:
//   * operational AppErrors now carry `code` at the envelope root and
//     `details` nested — previously both were dropped on the wire;
//   * the non-operational tail (logger + site-local generic 500) is
//     byte-identical, and the predicate stays `err.isOperational` — an error
//     that merely has a statusCode must NOT be relayed.

const TENANT = '00000000-0000-4000-8000-000000000001';

const prismaQueryRawUnsafeMock = jest.fn();
const createPreauthMock = jest.fn();
const getPreauthMock = jest.fn();
const submitPreauthMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: prismaQueryRawUnsafeMock },
}));

jest.unstable_mockModule('../../services/insurance/claimsService.js', () => ({
  createPreauth: createPreauthMock,
  getPreauth: getPreauthMock,
  submitPreauth: submitPreauthMock,
}));

jest.unstable_mockModule('../../services/insurance/clinicalJustificationTemplate.js', () => ({
  ENHANCEMENT_JUSTIFICATION_TEMPLATE: { version: 1 },
  normalizeClinicalJustification: () => ({ text: 'Justified', format: 'text', structured: null }),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT,
}));

const { default: enhancementRouter } = await import('../../routes/insurance/admissionEnhancementRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR', name: 'Dr Test' };
  next();
});
app.use('/api/v1/admissions/:admissionId/tpa-enhancement', enhancementRouter);

beforeEach(() => {
  prismaQueryRawUnsafeMock.mockReset();
  createPreauthMock.mockReset();
  getPreauthMock.mockReset();
  submitPreauthMock.mockReset();
});

describe('admission tpa-enhancement routes surface AppError code + details', () => {
  test('GET / relays an operational AppError with code and details', async () => {
    prismaQueryRawUnsafeMock.mockRejectedValueOnce(AppError.conflict(
      'Preauth chain is being modified by another request',
      'TPA_PREAUTH_CHAIN_LOCKED',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/admissions/5/tpa-enhancement');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Preauth chain is being modified by another request');
    expect(response.body.code).toBe('TPA_PREAUTH_CHAIN_LOCKED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('POST / relays an operational AppError from createPreauth', async () => {
    // resolveParentPreauth finds an active parent…
    prismaQueryRawUnsafeMock.mockResolvedValueOnce([{
      id: 3,
      preauth_number: 'PA-3',
      policy_id: 1,
      patient_uid: 'patient-1',
      admission_id: 5,
      primary_diagnosis: 'Cholecystitis',
      status: 'approved',
    }]);
    // …then the service rejects the enhancement.
    createPreauthMock.mockRejectedValueOnce(AppError.badRequest(
      'Enhancement exceeds the remaining policy cap',
      'TPA_ENHANCEMENT_CAP_EXCEEDED',
      { cap: 50000 },
    ));

    const response = await request(app)
      .post('/api/v1/admissions/5/tpa-enhancement')
      .send({ expected_cost: 90000, justification: 'New complication' });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('TPA_ENHANCEMENT_CAP_EXCEEDED');
    expect(response.body.details).toEqual({ cap: 50000 });
  });

  test('submit relays an operational AppError from getPreauth', async () => {
    getPreauthMock.mockRejectedValueOnce(AppError.conflict(
      'Pre-auth is not in a submittable state',
      'TPA_PREAUTH_NOT_SUBMITTABLE',
      { status: 'submitted' },
    ));

    const response = await request(app)
      .post('/api/v1/admissions/5/tpa-enhancement/7/submit')
      .send({});

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('TPA_PREAUTH_NOT_SUBMITTABLE');
    expect(response.body.details).toEqual({ status: 'submitted' });
    expect(submitPreauthMock).not.toHaveBeenCalled();
  });

  test('non-AppError keeps the byte-identical logged generic 500 tail and never leaks err.message', async () => {
    getPreauthMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'admission_id')"),
    );

    const response = await request(app)
      .post('/api/v1/admissions/5/tpa-enhancement/7/submit')
      .send({});

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to submit pre-auth');
    expect(JSON.stringify(response.body)).not.toMatch(/admission_id/);
  });

  test('predicate stays isOperational: a statusCode-only error is NOT relayed (R6 pin)', async () => {
    const notOperational = new Error('upstream TPA gateway returned bad status');
    notOperational.statusCode = 502; // AppError-shaped, but isOperational is unset
    getPreauthMock.mockRejectedValueOnce(notOperational);

    const response = await request(app)
      .post('/api/v1/admissions/5/tpa-enhancement/7/submit')
      .send({});

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to submit pre-auth');
    expect(response.body).not.toHaveProperty('code');
    expect(JSON.stringify(response.body)).not.toMatch(/upstream TPA gateway/);
  });
});
