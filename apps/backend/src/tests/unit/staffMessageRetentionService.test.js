import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const infoMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: infoMock,
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  purgeExpiredStaffMessages,
  purgeExpiredStaffMessagesForTenant,
} = await import('../../services/messaging/staffMessageRetentionService.js');

beforeEach(() => {
  queryUnsafeMock.mockReset();
  infoMock.mockReset();
});

describe('staff message retention purge', () => {
  it('deletes messages older than the configured retention window and refreshes affected threads', async () => {
    const threadId = '11111111-1111-4111-8111-111111111111';
    queryUnsafeMock
      .mockResolvedValueOnce([{
        deleted_messages: 2,
        deleted_attachments: 1,
        affected_thread_ids: [threadId],
      }])
      .mockResolvedValueOnce([{ id: threadId }])
      .mockResolvedValueOnce([{ thread_id: threadId }])
      .mockResolvedValueOnce([]);

    const result = await purgeExpiredStaffMessages({
      retentionDays: 30,
      batchSize: 25,
    });

    expect(result).toEqual(expect.objectContaining({
      retention_days: 30,
      batch_size: 25,
      deleted_messages: 2,
      deleted_attachments: 1,
      updated_threads: 1,
      deleted_thread_participants: 1,
      deleted_threads: 0,
    }));
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/staff_messages/);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/INTERVAL '1 day'/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/last_message_id/);
    expect(infoMock).toHaveBeenCalledWith(
      'Staff message retention purge completed',
      expect.objectContaining({ deleted_messages: 2 }),
    );
  });

  it('does not touch threads when no old messages were removed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      deleted_messages: 0,
      deleted_attachments: 0,
      affected_thread_ids: [],
    }]);

    const result = await purgeExpiredStaffMessages();

    expect(result.deleted_messages).toBe(0);
    expect(result.updated_threads).toBe(0);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('supports tenant-scoped purge for maintenance tooling', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      deleted_messages: 3,
      deleted_attachments: 4,
    }]);

    const tenantId = '00000000-0000-4000-8000-000000000001';
    const result = await purgeExpiredStaffMessagesForTenant({
      tenantId,
      retentionDays: 45,
      batchSize: 10,
    });

    expect(result).toEqual({
      tenant_id: tenantId,
      retention_days: 45,
      batch_size: 10,
      deleted_messages: 3,
      deleted_attachments: 4,
    });
    expect(queryUnsafeMock.mock.calls[0][1]).toBe(tenantId);
  });
});
