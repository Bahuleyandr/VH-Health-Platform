import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// scheduling handleFailure (previously `err.details ?? { code: err.code }`).

const listTemplatesMock = jest.fn();

jest.unstable_mockModule('../../services/scheduling/schedulingOptimizationService.js', () => ({
  upsertTemplate: jest.fn(),
  listTemplates: listTemplatesMock,
  recordLeave: jest.fn(),
  recordTemplateException: jest.fn(),
  listTemplateExceptions: jest.fn(),
  getSlotGrid: jest.fn(),
  createSlotHold: jest.fn(),
  confirmSlotHold: jest.fn(),
  releaseSlotHold: jest.fn(),
  addToWaitlist: jest.fn(),
  fillWaitlist: jest.fn(),
  resolveWaitlistEntry: jest.fn(),
  saveOverbookPolicy: jest.fn(),
  listOverbookPolicies: jest.fn(),
  evaluateOverbookRequest: jest.fn(),
  createResource: jest.fn(),
  addResourceCompatibility: jest.fn(),
  listResourceCompatibility: jest.fn(),
  bookResource: jest.fn(),
  listResourceSchedule: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: schedulingRoutes } = await import('../../routes/scheduling/schedulingRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/scheduling', schedulingRoutes);

beforeEach(() => {
  listTemplatesMock.mockReset();
});

describe('scheduling handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listTemplatesMock.mockRejectedValueOnce(AppError.conflict(
      'Template overlaps an existing availability window',
      'SCHEDULING_TEMPLATE_OVERLAP',
      { doctor_id: 7, weekday: 2 },
    ));

    const response = await request(app).get('/api/v1/scheduling/templates/7');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SCHEDULING_TEMPLATE_OVERLAP');
    expect(response.body.details).toEqual({ doctor_id: 7, weekday: 2 });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listTemplatesMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/scheduling/templates/7');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list templates');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
