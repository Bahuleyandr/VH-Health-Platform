import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for integrityRoutes.js — relay-variants
// port of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`; the relay lifts err.code to the
// envelope root unconditionally and keeps err.details under `details`.

const signDocumentMock = jest.fn();
const verifyDocumentSignatureMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/documentIntegrityService.js', () => ({
  signDocument: signDocumentMock,
  verifyDocumentSignature: verifyDocumentSignatureMock,
  listDocumentSignatures: jest.fn(),
  verifyAuditChain: jest.fn(),
}));

const { default: integrityRoutes } = await import('../../routes/clinical/integrityRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // DOCTOR passes the canSign() gate on POST /sign.
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/integrity', integrityRoutes);

beforeEach(() => {
  signDocumentMock.mockReset();
  verifyDocumentSignatureMock.mockReset();
});

describe('integrity handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    signDocumentMock.mockRejectedValueOnce(
      AppError.conflict('Document already carries a signature of this type', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app)
      .post('/api/v1/integrity/sign')
      .send({ document_type: 'discharge_summary', document_id: 42 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    verifyDocumentSignatureMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'content_hash')"),
    );

    const response = await request(app).get('/api/v1/integrity/signatures/7/verify');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to verify signature');
    expect(response.body.message).not.toMatch(/content_hash/);
  });
});
