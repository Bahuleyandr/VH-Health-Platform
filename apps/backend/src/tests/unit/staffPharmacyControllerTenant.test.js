import { jest } from '@jest/globals';

const updatePharmacyOrderStatus = jest.fn();

jest.unstable_mockModule('../../services/staff/pharmacyService.js', () => ({
  updatePharmacyOrderStatus,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const { updatePharmacyOrder } = await import('../../controllers/staff/pharmacyController.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const STAFF_UID = '20000000-0000-4000-8000-000000000002';

function response() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  updatePharmacyOrderStatus.mockResolvedValue({ order: { id: 55 } });
});

it('threads the authenticated tenant into the pharmacy status mutation', async () => {
  const req = {
    tenantId: TENANT_ID,
    user: { uid: STAFF_UID, role: 'PHARMACY_STAFF', name: 'Pharmacist One' },
    body: {
      phone: '+919000000001',
      order_id: 55,
      status: 'dispensed',
    },
  };

  await updatePharmacyOrder(req, response());

  expect(updatePharmacyOrderStatus).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT_ID,
    updatedBy: STAFF_UID,
    phone: '+919000000001',
  }));
});
