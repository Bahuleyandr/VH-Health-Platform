import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const queryRawMock = jest.fn();
const queueMock = jest.fn();
const publishEventMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn({ $queryRawUnsafe: queryRawMock }));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenant: jest.fn(),
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn() },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (value) => value,
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/operationalAlertEvaluators.js', () => ({
  OPERATIONAL_ALERT_EVALUATORS: [],
}));
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: publishEventMock,
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: queueMock },
}));

const { __testing__ } = await import('../../services/ai/operationalAlertService.js');

const candidate = {
  owner_role: 'MATERIALS_MANAGER',
  module_key: 'inventory_intelligence',
  domain: 'inventory',
  severity: 'high',
  scope_key: 'inv:gloves',
  scope_label: 'Surgical gloves',
  alert_category: 'stockout_risk',
  summary: 'Stockout risk is high',
};

beforeEach(() => {
  jest.clearAllMocks();
  queryRawMock
    .mockResolvedValueOnce([{ id: 91, notified_at: null }])
    .mockResolvedValueOnce([{ id: 51, phone: '+919800000051', role: 'MATERIALS_MANAGER' }])
    .mockResolvedValueOnce([]);
  queueMock.mockResolvedValue({ id: 201, status: 'PENDING' });
  publishEventMock.mockResolvedValue({ id: '301', status: 'pending' });
});

describe('operational alert durable notification', () => {
  test('resolves a concrete owner and stamps only after strict outbox and event enqueue', async () => {
    const result = await __testing__.notifyAndStamp(TENANT, candidate, 91);

    expect(queueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        recipientId: 51,
        sourceEventKey: 'operational-alert:91:51',
      }),
      expect.objectContaining({ strict: true }),
    );
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      tx: expect.anything(),
    }));
    expect(queryRawMock.mock.calls[2][0]).toMatch(/SET notified_at = NOW\(\)/);
    expect(result).toEqual({ notified: true, recipients: 1 });
  });

  test('does not stamp or publish when durable recipient enqueue is unconfirmed', async () => {
    queueMock.mockResolvedValueOnce(null);

    await expect(__testing__.notifyAndStamp(TENANT, candidate, 91))
      .rejects.toThrow('enqueue was not confirmed');

    expect(queryRawMock).toHaveBeenCalledTimes(2);
    expect(publishEventMock).not.toHaveBeenCalled();
  });
});
