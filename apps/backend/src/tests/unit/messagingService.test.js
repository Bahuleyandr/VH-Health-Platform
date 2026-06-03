import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn()
};

const notificationQueueMock = jest.fn();
const emitStaffMessageMock = jest.fn();
const loggerMock = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: loggerMock
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: {
    queue: notificationQueueMock
  },
  notificationOutbox: {
    queue: notificationQueueMock
  }
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitStaffMessage: emitStaffMessageMock
}));

const messagingService = (await import('../../services/messaging/messagingService.js')).default;

const tenantId = '00000000-0000-4000-8000-000000000001';
const senderUid = '11111111-1111-4111-8111-111111111111';
const recipientOne = '22222222-2222-4222-8222-222222222222';
const recipientTwo = '33333333-3333-4333-8333-333333333333';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
  prismaMock.$executeRawUnsafe.mockReset();
  prismaMock.$transaction.mockReset();
  notificationQueueMock.mockReset();
  emitStaffMessageMock.mockReset();
  Object.values(loggerMock).forEach(fn => fn.mockReset());
});

describe('messagingService', () => {
  it('persists a direct staff message with tenant and queues a notification', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 7,
          sender_uid: senderUid,
          recipient_uid: recipientOne,
          patient_uid: null,
          subject: 'Bed update',
          body: 'Patient shifted to B block.',
          priority: 'urgent',
          is_read: false,
          read_at: null,
          created_at: new Date('2026-06-03T08:00:00Z'),
          tenant_id: tenantId
        }
      ])
      .mockResolvedValueOnce([{ id: 42 }]);
    notificationQueueMock.mockResolvedValueOnce({ id: 99 });

    const message = await messagingService.sendMessage(
      senderUid,
      recipientOne,
      'Patient shifted to B block.',
      'urgent',
      null,
      'Bed update',
      tenantId
    );

    expect(message).toEqual(
      expect.objectContaining({
        id: 7,
        tenant_id: tenantId,
        priority: 'urgent'
      })
    );
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe(senderUid);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][2]).toBe(recipientOne);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][7]).toBe(tenantId);
    expect(notificationQueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 42,
        title: 'New staff message',
        data: expect.objectContaining({
          type: 'staff_message',
          message_id: 7,
          sender_uid: senderUid,
          priority: 'urgent'
        })
      })
    );
    expect(emitStaffMessageMock).toHaveBeenCalledTimes(1);
    expect(emitStaffMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUid: recipientOne,
        senderUid,
        priority: 'urgent',
        subject: 'Bed update',
        message: expect.objectContaining({ id: 7 })
      })
    );
  });

  it('allows HR/Admin all-staff broadcast and creates one saved row per recipient', async () => {
    const tx = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([
          {
            uid: senderUid,
            name: 'HR User',
            role: 'HR_STAFF',
            tenant_id: tenantId,
            department: 'HR'
          }
        ])
        .mockResolvedValueOnce([{ uid: recipientOne }, { uid: recipientTwo }])
        .mockResolvedValueOnce([
          {
            id: 11,
            sender_uid: senderUid,
            recipient_uid: recipientOne,
            patient_uid: null,
            subject: 'Policy',
            body: 'New shift policy is live.',
            priority: 'normal',
            is_read: false,
            read_at: null,
            created_at: new Date('2026-06-03T08:00:00Z'),
            tenant_id: tenantId
          }
        ])
        .mockResolvedValueOnce([
          {
            id: 12,
            sender_uid: senderUid,
            recipient_uid: recipientTwo,
            patient_uid: null,
            subject: 'Policy',
            body: 'New shift policy is live.',
            priority: 'normal',
            is_read: false,
            read_at: null,
            created_at: new Date('2026-06-03T08:00:01Z'),
            tenant_id: tenantId
          }
        ]),
      $executeRawUnsafe: jest.fn()
    };
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 42 }]);
    notificationQueueMock.mockResolvedValue({ id: 99 });

    const result = await messagingService.sendBroadcast({
      senderUid,
      tenantId,
      actorRole: 'HR_STAFF',
      scope: 'all',
      body: 'New shift policy is live.',
      subject: 'Policy'
    });

    expect(result.count).toBe(2);
    expect(result.messages.map(msg => msg.recipient_uid)).toEqual([recipientOne, recipientTwo]);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(4);
    expect(notificationQueueMock).toHaveBeenCalledTimes(2);
    expect(emitStaffMessageMock).toHaveBeenCalledTimes(2);
    expect(emitStaffMessageMock.mock.calls.map(call => call[0].recipientUid)).toEqual([
      recipientOne,
      recipientTwo
    ]);
  });

  it('blocks department incharges from messaging a different department', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([
        {
          uid: senderUid,
          name: 'Nursing Incharge',
          role: 'NURSING_INCHARGE',
          tenant_id: tenantId,
          department: 'Nursing'
        }
      ]),
      $executeRawUnsafe: jest.fn()
    };
    prismaMock.$transaction.mockImplementationOnce(callback => callback(tx));

    await expect(
      messagingService.sendBroadcast({
        senderUid,
        tenantId,
        actorRole: 'NURSING_INCHARGE',
        scope: 'department',
        department: 'Billing',
        body: 'Please review this update.'
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Department incharges can only message their own department'
    });

    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(notificationQueueMock).not.toHaveBeenCalled();
    expect(emitStaffMessageMock).not.toHaveBeenCalled();
  });
});
