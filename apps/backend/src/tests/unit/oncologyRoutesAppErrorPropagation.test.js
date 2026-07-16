import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// oncology handleFailure (previously `err.details ?? { code: err.code }`).

const listProtocolsMock = jest.fn();

jest.unstable_mockModule('../../services/oncology/chemoService.js', () => ({
  createProtocol: jest.fn(),
  activateProtocol: jest.fn(),
  getProtocol: jest.fn(),
  listProtocols: listProtocolsMock,
  createTreatmentPlan: jest.fn(),
  scheduleCycle: jest.fn(),
  createInfusionChair: jest.fn(),
  listInfusionChairs: jest.fn(),
  updateInfusionChairStatus: jest.fn(),
  bookInfusionChair: jest.fn(),
  cancelChairBooking: jest.fn(),
  getInfusionBoard: jest.fn(),
  verifyAdministration: jest.fn(),
  recordChemoAdministration: jest.fn(),
  withholdAdministration: jest.fn(),
  getPatientCumulative: jest.fn(),
  getPlanDetail: jest.fn(),
}));

jest.unstable_mockModule('../../services/oncology/oncologyCompletionService.js', () => ({
  getOncologyCompletionSettings: jest.fn(),
  setOncologyCompletionSettings: jest.fn(),
  createOncologyDiagnosis: jest.fn(),
  listOncologyDiagnoses: jest.fn(),
  createStagingRecord: jest.fn(),
  signStagingRecord: jest.fn(),
  createToxicityEvent: jest.fn(),
  listToxicityEvents: jest.fn(),
  signToxicityEvent: jest.fn(),
  createTumorBoardMeeting: jest.fn(),
  createTumorBoardCase: jest.fn(),
  listTumorBoardQueue: jest.fn(),
  updateTumorBoardCaseState: jest.fn(),
  createTumorBoardRecommendation: jest.fn(),
  updateTumorBoardRecommendationStatus: jest.fn(),
  createRegistryExport: jest.fn(),
  reviewRegistryExport: jest.fn(),
}));

const { default: oncologyRoutes } = await import('../../routes/oncology/oncologyRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/oncology', oncologyRoutes);

beforeEach(() => {
  listProtocolsMock.mockReset();
});

describe('oncology handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listProtocolsMock.mockRejectedValueOnce(AppError.conflict(
      'Protocol code already exists',
      'CHEMO_PROTOCOL_DUPLICATE',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/oncology/protocols');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('CHEMO_PROTOCOL_DUPLICATE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listProtocolsMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/oncology/protocols');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list protocols');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
