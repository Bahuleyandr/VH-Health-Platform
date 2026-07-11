import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000099';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const recordMovementMock = jest.fn(async (input) => input);
const dispenseControlledMock = jest.fn(async (input) => input);

jest.unstable_mockModule('../../services/pharmacy/inventoryV2Service.js', () => ({
  createItem: jest.fn(),
  dispenseControlled: dispenseControlledMock,
  listBatches: jest.fn(),
  listExpiryAlerts: jest.fn(),
  listItems: jest.fn(),
  listScheduleRegister: jest.fn(),
  recordMovement: recordMovementMock,
  runExpiryScan: jest.fn(),
  tenantOf: () => TENANT,
}));

const { default: inventoryRoutes } = await import(
  '../../routes/pharmacy/inventoryV2Routes.js'
);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: ACTOR, name: 'Pharmacist', role: 'PHARMACY_STAFF' };
  next();
});
app.use('/api/v1/pharmacy/inventory/v2', inventoryRoutes);

beforeEach(() => {
  recordMovementMock.mockClear();
  dispenseControlledMock.mockClear();
});

describe('pharmacy inventory route tenant boundary', () => {
  test('pins stock movements to the authenticated tenant', async () => {
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/movements')
      .send({
        tenantId: OTHER_TENANT,
        inventory_item_id: 17,
        movement_kind: 'issue',
        quantity: 1,
      });

    expect(response.statusCode).toBe(200);
    expect(recordMovementMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      performed_by: ACTOR,
    }));
  });

  test('pins controlled dispensing to the authenticated tenant', async () => {
    const response = await request(app)
      .post('/api/v1/pharmacy/inventory/v2/controlled-dispense')
      .send({
        tenantId: OTHER_TENANT,
        inventory_item_id: 17,
        quantity: 1,
      });

    expect(response.statusCode).toBe(200);
    expect(dispenseControlledMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      performed_by: ACTOR,
      performed_by_name: 'Pharmacist',
    }));
  });
});
