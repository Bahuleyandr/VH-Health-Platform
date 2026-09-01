import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const REQUESTER = '11111111-1111-4111-8111-111111111111';
const WITNESS = '22222222-2222-4222-8222-222222222222';
const preflightMock = jest.fn(async (input) => input);
const approveMock = jest.fn(async (input) => input);
const authenticateMock = jest.fn(async ({ tenantId }) => ({
  uid: WITNESS,
  tenantId,
}));

const handler = jest.fn((_req, res) => res.status(200).json({ ok: true }));
const orderHandlers = Object.fromEntries([
  'assignOrderFacility',
  'cancelOrder',
  'completeDeliveryReturn',
  'confirmOrder',
  'dispatchOrder',
  'getAssignedDeliveries',
  'getDeliveryAssignees',
  'getDispenseLabel',
  'getMyOrders',
  'getOrderDetail',
  'getOrderDispensableContext',
  'getOrderQueue',
  'getPharmacySLADashboard',
  'markCounterDispensed',
  'markDelivered',
  'markPreparing',
  'markUnavailable',
  'placeOrder',
  'reissueDeliveryHandoff',
  'requestDeliveryReturn',
  'resolveOrderLineIdentities',
].map((name) => [name, handler]));

jest.unstable_mockModule('../../config/routeWrapper.js', () => ({
  wrapAutoRBAC: jest.fn(),
}));
jest.unstable_mockModule('../../controllers/pharmacy/orderController.js', () => ({
  getOrdersByUID: handler,
}));
jest.unstable_mockModule('../../controllers/pharmacy/pharmacyOrderController.js', () => (
  orderHandlers
));
jest.unstable_mockModule('../../controllers/pharmacy/pharmacyVerificationController.js', () => ({
  getPharmacyPackLabel: handler,
  verifyPharmacyOrder: handler,
}));
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../routes/pharmacy/pharmacyOrderPatientGuards.js', () => ({
  pharmacyOrderGuard: () => (_req, _res, next) => next(),
  selectOrderPatient: () => null,
}));
jest.unstable_mockModule('../../services/auth/staffAuthService.js', () => ({
  StaffAuthService: {
    authenticateControlledDispenseWitness: authenticateMock,
  },
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacyOrderInventoryService.js', () => ({
  approveOrderControlledWitnessApproval: approveMock,
  preflightOrderControlledWitnessApproval: preflightMock,
  requestOrderControlledWitnessApproval: jest.fn(),
}));

const { default: orderRoutes } = await import('../../routes/pharmacy/orderRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = TENANT;
  req.user = { uid: REQUESTER, role: 'PHARMACY_STAFF' };
  next();
});
app.use('/orders', orderRoutes);

beforeEach(() => {
  preflightMock.mockReset();
  preflightMock.mockImplementation(async (input) => input);
  approveMock.mockClear();
  authenticateMock.mockClear();
});

test('order witness preflight precedes password authentication and decision', async () => {
  const response = await request(app)
    .post('/orders/73/controlled-dispense/witness-approvals/71/approve')
    .send({
      employeeId: 'PHARM-002',
      password: 'witness-secret',
      selection: {
        order_line_index: 0,
        inventory_item_id: 17,
        inventory_batch_id: 29,
        quantity: 1,
      },
    });

  expect(response.statusCode).toBe(200);
  expect(preflightMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT,
    orderId: '73',
    approvalId: '71',
    requestedBy: REQUESTER,
    requestedByRole: 'PHARMACY_STAFF',
  }));
  expect(preflightMock.mock.invocationCallOrder[0])
    .toBeLessThan(authenticateMock.mock.invocationCallOrder[0]);
  expect(authenticateMock.mock.invocationCallOrder[0])
    .toBeLessThan(approveMock.mock.invocationCallOrder[0]);
  expect(approveMock).toHaveBeenCalledWith(expect.objectContaining({
    witnessUid: WITNESS,
    requestedBy: REQUESTER,
  }));
  expect(authenticateMock.mock.calls[0][0].req.body).not.toHaveProperty('password');
});

test('bogus order approval evidence cannot invoke staff password authentication', async () => {
  preflightMock.mockRejectedValueOnce(Object.assign(new Error('Approval does not match'), {
    statusCode: 409,
    code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
  }));

  const response = await request(app)
    .post('/orders/73/controlled-dispense/witness-approvals/999/approve')
    .send({
      employeeId: 'PHARM-002',
      password: 'wrong-secret',
      selection: {
        order_line_index: 0,
        inventory_item_id: 17,
        inventory_batch_id: 29,
        quantity: 1,
      },
    });

  expect(response.statusCode).toBe(409);
  expect(authenticateMock).not.toHaveBeenCalled();
  expect(approveMock).not.toHaveBeenCalled();
});
