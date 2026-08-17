import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — pharmacy-inventory twin of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602 pattern).
//
// inventoryV2Routes.js wraps every handler in a local `wrap()` whose catch
// branch used to call `error(res, err.message, err.statusCode)` with no 4th
// arg (dropping `err.code` / `err.details` from the documented envelope) and
// to relay raw `err.message` on the generic 500. It now delegates to
// responseHelper.relayAppError with this file's generic 'Inventory error'.
// These tests drive an endpoint over HTTP and assert the response body.

const listItemsMock = jest.fn();

// Note: this route file resolves the tenant via the service's own
// `inv.tenantOf(req)` (it does not import tenantService directly), so the
// mock must provide tenantOf too.
jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  CONTROLLED_DISPENSE_WITNESS_ROLES: [
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
    'DOCTOR',
    'DUTY_DOCTOR',
    'MEDICAL_SUPERINTENDENT',
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'OP_STAFF_NURSE',
    'OP_INCHARGE',
  ],
  tenantOf: () => '00000000-0000-4000-8000-000000000001',
  listItems: listItemsMock,
}));

const { default: inventoryV2Routes } = await import('../../routes/pharmacy/inventoryV2Routes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'PHARMACY_STAFF' };
  next();
});
app.use('/api/v1/pharmacy/inventory/v2', inventoryV2Routes);

beforeEach(() => {
  listItemsMock.mockReset();
});

describe('pharmacy inventoryV2 route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    listItemsMock.mockRejectedValueOnce(AppError.conflict(
      'Stock take in progress — item list is frozen for this store',
      'INVENTORY_STOCK_TAKE_IN_PROGRESS',
      { reason: 'stock_take_freeze' },
    ));

    const response = await request(app).get('/api/v1/pharmacy/inventory/v2/items');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('INVENTORY_STOCK_TAKE_IN_PROGRESS');
    expect(response.body.details).toEqual({ reason: 'stock_take_freeze' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // Old wrap relayed `err.message || 'Inventory error'` — internals leaked
    // on non-prod deployments where sanitize does not genericise 5xx.
    listItemsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'batch_number')"),
    );

    const response = await request(app).get('/api/v1/pharmacy/inventory/v2/items');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Inventory error');
    expect(JSON.stringify(response.body)).not.toContain('Cannot read properties');
  });
});
