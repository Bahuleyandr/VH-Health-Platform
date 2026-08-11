import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordEventDeadLettered: jest.fn(),
  recordEventOutboxLeaseReaped: jest.fn(),
  recordOutboxOperatorRedrive: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: value => value,
}));

const { claimPendingEvents } = await import('../../services/events/eventOutboxService.js');

describe('event outbox claim honesty', () => {
  it('propagates a database claim failure instead of reporting a clean empty queue', async () => {
    setTenantTxMock.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(claimPendingEvents({
      limit: 5,
      leaseOwner: '11111111-1111-4111-8111-111111111111',
    })).rejects.toThrow('database unavailable');
  });
});
