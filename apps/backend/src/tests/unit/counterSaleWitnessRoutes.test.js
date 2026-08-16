import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const requestApprovalMock = jest.fn(async (input) => input);
const approveApprovalMock = jest.fn(async (input) => input);

jest.unstable_mockModule('../../services/pharmacy/counterSaleService.js', () => ({
  approveCounterSaleWitnessApproval: approveApprovalMock,
  requestCounterSaleWitnessApproval: requestApprovalMock,
}));
jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  tenantOf: () => TENANT,
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

const { default: counterSaleRoutes } = await import(
  '../../routes/pharmacy/counterSaleRoutes.js'
);

let actorRole = 'PHARMACY_STAFF';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: ACTOR, role: actorRole };
  next();
});
app.use('/counter-sales', counterSaleRoutes);

beforeEach(() => {
  actorRole = 'PHARMACY_STAFF';
  requestApprovalMock.mockClear();
  approveApprovalMock.mockClear();
});

test('counter-sale witness endpoints bind seller and approver to authenticated actors', async () => {
  const requestResponse = await request(app)
    .post('/counter-sales/witness-approvals')
    .send({ tenantId: 'caller-tenant', requested_by: 'caller-actor', lines: [] });
  expect(requestResponse.statusCode).toBe(200);
  expect(requestApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT,
    requested_by: ACTOR,
  }));

  const approvalResponse = await request(app)
    .post('/counter-sales/witness-approvals/71/approve')
    .send({ actorUid: 'caller-actor', sale: { tenantId: 'caller-tenant', lines: [] } });
  expect(approvalResponse.statusCode).toBe(200);
  expect(approveApprovalMock).toHaveBeenCalledWith({
    approvalId: '71',
    actorUid: ACTOR,
    sale: { tenantId: TENANT, lines: [] },
  });
});

test('ADMIN cannot provide the controlled-dispense second signature', async () => {
  actorRole = 'ADMIN';
  const response = await request(app)
    .post('/counter-sales/witness-approvals/71/approve')
    .send({ sale: { lines: [] } });
  expect(response.statusCode).toBe(403);
  expect(approveApprovalMock).not.toHaveBeenCalled();
});
