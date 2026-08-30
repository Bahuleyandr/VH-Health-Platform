// Route-contract unit test for the dispense-substitution witness approval
// routers (mirrors counterSaleWitnessRoutes.test.js): both mutations demand a
// durable Idempotency-Key claim, the approval idempotency projection NEVER
// contains the witness password, requester/approver identities bind to the
// authenticated actors (never caller-supplied body fields), and role gates
// hold on both routers.
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

jest.unstable_mockModule('../../controllers/pharmacy/pharmacyOrderController.js', () => ({
  requestSubstitutionWitnessApproval: requestApprovalMock,
  approveSubstitutionWitnessApproval: approveApprovalMock,
  preflightSubstitutionWitnessApproval: preflightApprovalMock,
}));
jest.unstable_mockModule('../../services/pharmacy/controlledDispenseWitnessService.js', () => ({
  CONTROLLED_DISPENSE_WITNESS_ROLES: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'NURSING_STAFF'],
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

// Per-route patient guard (re-audit M mount fix) — pass-through: this suite
// pins witness-approval mechanics, not access decisions.
jest.unstable_mockModule('../../routes/pharmacy/pharmacyOrderPatientGuards.js', () => ({
  pharmacyOrderGuard: () => (_req, _res, next) => next(),
  selectOrderPatient: () => async () => null,
  selectPatientByBodyPhone: async () => null,
  selectCounterSalePatient: async () => null,
  selectPatientFromBodyUid: () => null,
  tenantOf: (req) => req.tenantId ?? null,
}));

const {
  default: substitutionWitnessRoutes,
  pharmacySubstitutionWitnessApprovalRoutes,
} = await import(
  '../../routes/pharmacy/dispenseSubstitutionWitnessRoutes.js'
);

let actorRole = 'PHARMACY_STAFF';
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: ACTOR, role: actorRole };
  req.tenantId = TENANT;
  next();
});
app.use(
  '/dispense-substitution/witness-approvals/:id/approve',
  pharmacySubstitutionWitnessApprovalRoutes,
);
app.use('/dispense-substitution/witness-approvals', substitutionWitnessRoutes);

beforeEach(() => {
  actorRole = 'PHARMACY_STAFF';
  requestApprovalMock.mockClear();
  preflightApprovalMock.mockReset();
  preflightApprovalMock.mockImplementation(async (input) => input);
  approveApprovalMock.mockClear();
  authenticateWitnessMock.mockClear();
});

test('substitution witness endpoints require idempotency claims and exclude the password from the projection', async () => {
  expect(idempotencyScopes).toEqual(expect.arrayContaining([
    expect.objectContaining({
      required: true,
      scope: 'pharmacy_substitution_witness_request',
      retainOnServerError: true,
    }),
    expect.objectContaining({
      required: true,
      scope: 'pharmacy_substitution_witness_approval',
      retainOnServerError: true,
    }),
  ]));
  const approvalIdempotency = idempotencyScopes.find(
    ({ scope }) => scope === 'pharmacy_substitution_witness_approval',
  );
  const projectedApproval = approvalIdempotency.requestBodyForIdempotency({
    body: {
      actorUid: 'caller-selected',
      employeeId: ' nurse-002 ',
      password: 'witness-secret',
      substitution: { inventory_item_id: 5 },
    },
  });
  expect(projectedApproval).toEqual({
    credentialMode: 'staff_password',
    employeeId: 'NURSE-002',
    substitution: { inventory_item_id: 5 },
  });
  expect(JSON.stringify(projectedApproval)).not.toContain('witness-secret');
  // Bearer-mode projection carries no credential material at all.
  expect(approvalIdempotency.requestBodyForIdempotency({
    body: { substitution: { inventory_item_id: 5 } },
  })).toEqual({
    credentialMode: 'bearer',
    employeeId: null,
    substitution: { inventory_item_id: 5 },
  });
});

test('request + approve bind to the authenticated actor/tenant, never body fields', async () => {
  const requestResponse = await request(app)
    .post('/dispense-substitution/witness-approvals')
    .send({
      tenantId: 'caller-tenant',
      requested_by: 'caller-actor',
      requested_role: 'ADMIN',
      inventory_item_id: 5,
    });
  expect(requestResponse.statusCode).toBe(200);
  expect(requestApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT,
    requested_by: ACTOR,
    requested_role: 'PHARMACY_STAFF',
    inventory_item_id: 5,
  }));

  const approvalResponse = await request(app)
    .post('/dispense-substitution/witness-approvals/71/approve')
    .send({
      actorUid: 'caller-actor',
      employeeId: 'PHARM-002',
      password: 'witness-secret',
      substitution: { tenantId: 'caller-tenant', inventory_item_id: 5 },
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
    substitution: { tenantId: TENANT, inventory_item_id: 5 },
  });
  expect(preflightApprovalMock.mock.invocationCallOrder[0])
    .toBeLessThan(authenticateWitnessMock.mock.invocationCallOrder[0]);
  expect(approveApprovalMock).toHaveBeenCalledWith({
    approvalId: '71',
    actorUid: WITNESS,
    requesterUid: ACTOR,
    substitution: { tenantId: TENANT, inventory_item_id: 5 },
  });
});

test('invalid substitution approval evidence is rejected before staff password auth', async () => {
  const error = Object.assign(new Error('Approval does not match'), {
    statusCode: 409,
    code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
  });
  preflightApprovalMock.mockRejectedValueOnce(error);

  const response = await request(app)
    .post('/dispense-substitution/witness-approvals/999/approve')
    .send({
      employeeId: 'PHARM-002',
      password: 'wrong-secret',
      substitution: { inventory_item_id: 5 },
    });

  expect(response.statusCode).toBe(409);
  expect(authenticateWitnessMock).not.toHaveBeenCalled();
  expect(approveApprovalMock).not.toHaveBeenCalled();
});

test('bearer-mode approval uses the authenticated caller as witness', async () => {
  actorRole = 'NURSING_STAFF';
  const approvalResponse = await request(app)
    .post('/dispense-substitution/witness-approvals/72/approve')
    .send({ substitution: { inventory_item_id: 5 } });
  expect(approvalResponse.statusCode).toBe(200);
  expect(authenticateWitnessMock).not.toHaveBeenCalled();
  expect(approveApprovalMock).toHaveBeenCalledWith({
    approvalId: '72',
    actorUid: ACTOR,
    requesterUid: null,
    substitution: { tenantId: TENANT, inventory_item_id: 5 },
  });
});

test('half-supplied witness credentials fail closed and the password never persists on the body', async () => {
  const res = await request(app)
    .post('/dispense-substitution/witness-approvals/73/approve')
    .send({ password: 'witness-secret', substitution: {} });
  expect(res.statusCode).toBe(400);
  expect(res.body?.details?.code ?? res.body?.code).toBe(
    'CONTROLLED_DISPENSE_WITNESS_CREDENTIALS_REQUIRED',
  );
  expect(approveApprovalMock).not.toHaveBeenCalled();
});

test('role gates: requesting needs a dispensing role; approving accepts witness roles but not others', async () => {
  actorRole = 'NURSING_STAFF';
  const requestResponse = await request(app)
    .post('/dispense-substitution/witness-approvals')
    .send({ inventory_item_id: 5 });
  expect(requestResponse.statusCode).toBe(403);
  expect(requestApprovalMock).not.toHaveBeenCalled();

  actorRole = 'RECEPTIONIST';
  const approvalResponse = await request(app)
    .post('/dispense-substitution/witness-approvals/74/approve')
    .send({ substitution: {} });
  expect(approvalResponse.statusCode).toBe(403);
  expect(approveApprovalMock).not.toHaveBeenCalled();
});
