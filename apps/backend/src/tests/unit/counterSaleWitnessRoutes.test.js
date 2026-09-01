import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const WITNESS = '22222222-2222-4222-8222-222222222222';
const requestApprovalMock = jest.fn(async (input) => input);
const preflightApprovalMock = jest.fn(async (input) => input);
const approveApprovalMock = jest.fn(async (input) => input);
const authenticateWitnessMock = jest.fn(async ({ tenantId }) => ({
  uid: WITNESS,
  tenantId,
}));
const idempotencyScopes = [];

jest.unstable_mockModule('../../services/pharmacy/counterSaleService.js', () => ({
  approveCounterSaleWitnessApproval: approveApprovalMock,
  preflightCounterSaleWitnessApproval: preflightApprovalMock,
  requestCounterSaleWitnessApproval: requestApprovalMock,
}));
jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  tenantOf: () => TENANT,
}));
jest.unstable_mockModule('../../services/auth/staffAuthService.js', () => ({
  StaffAuthService: {
    authenticateControlledDispenseWitness: authenticateWitnessMock,
  },
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: (options) => {
    idempotencyScopes.push(options);
    return (_req, _res, next) => next();
  },
}));

const {
  default: counterSaleRoutes,
  pharmacyCounterSaleWitnessApprovalRoutes,
} = await import(
  '../../routes/pharmacy/counterSaleRoutes.js'
);

let actorRole = 'PHARMACY_STAFF';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: ACTOR, role: actorRole };
  next();
});
app.use(
  '/counter-sales/witness-approvals/:id/approve',
  pharmacyCounterSaleWitnessApprovalRoutes,
);
app.use('/counter-sales', counterSaleRoutes);

beforeEach(() => {
  actorRole = 'PHARMACY_STAFF';
  requestApprovalMock.mockClear();
  preflightApprovalMock.mockReset();
  preflightApprovalMock.mockImplementation(async (input) => input);
  approveApprovalMock.mockClear();
  authenticateWitnessMock.mockClear();
});

test('counter-sale witness endpoints bind seller and approver to authenticated actors', async () => {
  expect(idempotencyScopes).toEqual(expect.arrayContaining([
    expect.objectContaining({
      required: true,
      scope: 'pharmacy_counter_sale_witness_request',
      retainOnServerError: true,
    }),
    expect.objectContaining({
      required: true,
      scope: 'pharmacy_counter_sale_witness_approval',
      retainOnServerError: true,
    }),
  ]));
  const approvalIdempotency = idempotencyScopes.find(
    ({ scope }) => scope === 'pharmacy_counter_sale_witness_approval',
  );
  const projectedApproval = approvalIdempotency.requestBodyForIdempotency({
    body: {
      actorUid: 'caller-selected',
      employeeId: ' nurse-002 ',
      password: 'witness-secret',
      sale: { lines: [] },
    },
  });
  expect(projectedApproval).toEqual({
    credentialMode: 'staff_password',
    employeeId: 'NURSE-002',
    sale: { lines: [] },
  });
  expect(JSON.stringify(projectedApproval)).not.toContain('witness-secret');
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
    .send({
      actorUid: 'caller-actor',
      employeeId: 'PHARM-002',
      password: 'witness-secret',
      sale: { tenantId: 'caller-tenant', lines: [] },
    });
  expect(approvalResponse.statusCode).toBe(200);
  expect(authenticateWitnessMock).toHaveBeenCalledWith({
    employeeId: 'PHARM-002',
    password: 'witness-secret',
    tenantId: TENANT,
    req: expect.objectContaining({ user: expect.objectContaining({ uid: ACTOR }) }),
  });
  expect(preflightApprovalMock).toHaveBeenCalledWith({
    approvalId: '71',
    requesterUid: ACTOR,
    sale: { tenantId: TENANT, lines: [] },
  });
  expect(preflightApprovalMock.mock.invocationCallOrder[0])
    .toBeLessThan(authenticateWitnessMock.mock.invocationCallOrder[0]);
  expect(approveApprovalMock).toHaveBeenCalledWith({
    approvalId: '71',
    actorUid: WITNESS,
    requesterUid: ACTOR,
    sale: { tenantId: TENANT, lines: [] },
  });
});

test('an invalid approval is refused before password authentication can affect a staff account', async () => {
  const error = Object.assign(new Error('Approval does not match'), {
    statusCode: 409,
    code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
  });
  preflightApprovalMock.mockRejectedValueOnce(error);

  const response = await request(app)
    .post('/counter-sales/witness-approvals/999/approve')
    .send({
      employeeId: 'PHARM-002',
      password: 'wrong-secret',
      sale: { lines: [] },
    });

  expect(response.statusCode).toBe(409);
  expect(authenticateWitnessMock).not.toHaveBeenCalled();
  expect(approveApprovalMock).not.toHaveBeenCalled();
});

test('ADMIN seller may host a separately authenticated eligible witness challenge', async () => {
  actorRole = 'ADMIN';
  const response = await request(app)
    .post('/counter-sales/witness-approvals/71/approve')
    .send({
      employeeId: 'NURSE-002',
      password: 'witness-secret',
      sale: { lines: [] },
    });
  expect(response.statusCode).toBe(200);
  expect(approveApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
    actorUid: WITNESS,
  }));
});

test('a partial witness credential challenge fails closed', async () => {
  const response = await request(app)
    .post('/counter-sales/witness-approvals/71/approve')
    .send({ employeeId: 'NURSE-002', sale: { lines: [] } });
  expect(response.statusCode).toBe(400);
  expect(authenticateWitnessMock).not.toHaveBeenCalled();
  expect(approveApprovalMock).not.toHaveBeenCalled();
});

test('a credential result from another tenant fails before approval', async () => {
  authenticateWitnessMock.mockResolvedValueOnce({
    uid: WITNESS,
    tenantId: '00000000-0000-4000-8000-000000000099',
  });
  const response = await request(app)
    .post('/counter-sales/witness-approvals/71/approve')
    .send({
      employeeId: 'NURSE-002',
      password: 'witness-secret',
      sale: { lines: [] },
    });
  expect(response.statusCode).toBe(403);
  expect(approveApprovalMock).not.toHaveBeenCalled();
});
