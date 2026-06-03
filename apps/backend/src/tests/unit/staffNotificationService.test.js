import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const sendToUserMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  sendToUser: sendToUserMock,
}));

const {
  resolveStaffNotificationRecipients,
  sendStaffNotifications,
} = await import('../../services/notification/staffNotificationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER_UID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  sendToUserMock.mockReset();
});

describe('central staff notification service', () => {
  it('resolves staff recipients by role and department within the tenant', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7,
      uid: USER_UID,
      name: 'Nurse One',
      phone: null,
      role: 'NURSING_STAFF',
      department: 'ICU',
    }]);

    const rows = await resolveStaffNotificationRecipients({
      tenantId: TENANT,
      recipientRoles: ['nursing_staff'],
      departments: ['ICU'],
    });

    expect(rows).toHaveLength(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/u\.tenant_id = \$1::uuid/);
    expect(queryUnsafeMock.mock.calls[0][4]).toEqual(['NURSING_STAFF']);
    expect(queryUnsafeMock.mock.calls[0][5]).toEqual(['icu']);
  });

  it('persists in-app rows and emits websocket notifications', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        uid: USER_UID,
        name: 'Nurse One',
        phone: null,
        role: 'NURSING_STAFF',
        department: 'ICU',
      }])
      .mockResolvedValueOnce([{
        id: 99,
        tenant_id: TENANT,
        uid: USER_UID,
        user_id: 7,
        phone: 'unknown',
        title: 'New IP admission',
        message: 'Patient admitted to ICU / B-112.',
        type: 'ADMISSION_CREATED',
        priority: 'MEDIUM',
        data: { admission_id: 12 },
        is_read: false,
        related_id: 12,
        recipient_role: 'NURSING_STAFF',
        created_at: new Date('2026-06-03T00:00:00.000Z'),
      }]);

    const result = await sendStaffNotifications({
      tenantId: TENANT,
      recipientRoles: ['NURSING_STAFF'],
      title: 'New IP admission',
      body: 'Patient admitted to ICU / B-112.',
      type: 'admission_created',
      relatedId: 12,
      data: { admission_id: 12 },
    });

    expect(result.notification_count).toBe(1);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO notifications/);
    expect(queryUnsafeMock.mock.calls[1][4]).toBe('ADMISSION_CREATED');
    expect(sendToUserMock).toHaveBeenCalledWith(
      USER_UID,
      'notification',
      expect.objectContaining({
        id: 99,
        title: 'New IP admission',
        type: 'ADMISSION_CREATED',
      }),
    );
  });

  it('returns a zero count when no recipients match', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    const result = await sendStaffNotifications({
      tenantId: TENANT,
      recipientRoles: ['HOUSEKEEPING_STAFF'],
      title: 'Housekeeping request raised',
      body: 'Cleaning needed in ICU.',
    });

    expect(result.notification_count).toBe(0);
    expect(sendToUserMock).not.toHaveBeenCalled();
  });
});
