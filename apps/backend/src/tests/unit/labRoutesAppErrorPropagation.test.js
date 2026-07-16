import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of labRoutes'
// wrap() catch. The old catch built `err.details ?? (err.code ? { code:
// err.code } : null)` (code buried under details when no details were set)
// and relayed `err.message || 'Lab error'` on the 500 tail. relayAppError
// lifts err.code to the envelope root, nests err.details, and hardens the
// 500 tail to the generic-only 'Lab error'.

const ingestOruMessageMock = jest.fn();

jest.unstable_mockModule('../../services/lab/labResultsService.js', () => ({
  ingestOruMessage: ingestOruMessageMock,
}));

jest.unstable_mockModule('../../services/lab/labClosedLoopService.js', () => ({}));

jest.unstable_mockModule('../../services/investigation/investigationService.js', () => ({}));

jest.unstable_mockModule('../../services/investigation/orderService.js', () => ({}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: labRoutes } = await import('../../routes/lab/labRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/lab', labRoutes);

beforeEach(() => {
  ingestOruMessageMock.mockReset();
});

describe('lab wrap() relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    ingestOruMessageMock.mockRejectedValueOnce(AppError.conflict(
      'Duplicate ORU message for accession',
      'LAB_ORU_DUPLICATE',
      { accession_number: 'ACC-1' },
    ));

    const response = await request(app)
      .post('/api/v1/lab/oru/ingest')
      .send({ message: 'MSH|^~\\&|ANALYZER', source: 'test' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('LAB_ORU_DUPLICATE');
    expect(response.body.details).toEqual({ accession_number: 'ACC-1' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('AppError without details produces root code and NO details key (R7 builder shape)', async () => {
    // The old builder produced `details: { code: ... }` for a details-less
    // AppError; the relay lifts the code to the root and must not emit a
    // spurious details object.
    ingestOruMessageMock.mockRejectedValueOnce(new AppError(
      'ORU message failed validation',
      422,
      'LAB_ORU_INVALID',
    ));

    const response = await request(app)
      .post('/api/v1/lab/oru/ingest')
      .send({ message: 'MSH|^~\\&|ANALYZER', source: 'test' });

    expect(response.statusCode).toBe(422);
    expect(response.body.code).toBe('LAB_ORU_INVALID');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError returns generic-only 500 (err.message no longer relayed)', async () => {
    // Old tail: `error(res, err.message || 'Lab error', 500)` leaked the raw
    // message; the port hardens this to the generic label only.
    ingestOruMessageMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app)
      .post('/api/v1/lab/oru/ingest')
      .send({ message: 'MSH|^~\\&|ANALYZER', source: 'test' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Lab error');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
