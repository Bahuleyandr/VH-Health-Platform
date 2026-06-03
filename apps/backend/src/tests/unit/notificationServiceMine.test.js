import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryUnsafeMock,
    $executeRawUnsafe: executeUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { notificationService } = await import('../../services/notification/notificationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER_UID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset();
});

describe('notificationService authenticated feed', () => {
  it('reads notifications by uid/user_id with legacy phone fallback', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        uid: USER_UID,
        phone: '+911234567890',
        role: 'RECEPTIONIST',
        tenant_id: TENANT,
      }])
      .mockResolvedValueOnce([{
        id: 99,
        tenant_id: TENANT,
        uid: USER_UID,
        user_id: 7,
        phone: '+911234567890',
        title: 'Appointment due soon',
        message: 'Token #3 is due.',
        type: 'APPOINTMENT_DUE',
        priority: 'MEDIUM',
        is_read: false,
        data: { appointment_id: 3 },
        related_id: 3,
        created_at: new Date('2026-06-03T00:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{ total: 1, unread_count: 1 }]);

    const result = await notificationService.getMyNotifications(
      { uid: USER_UID, role: 'RECEPTIONIST' },
      { limit: 20, offset: 0 },
    );

    expect(result.count).toBe(1);
    expect(result.unread_count).toBe(1);
    expect(result.notifications[0]).toEqual(expect.objectContaining({
      title: 'Appointment due soon',
      type: 'APPOINTMENT_DUE',
      is_read: false,
      related_id: 3,
    }));
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/n\.uid = \$1::uuid/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/n\.user_id = \$2::int/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/n\.phone = \$3/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/n\.tenant_id = \$4::uuid/);
  });

  it('marks only the authenticated user notifications as read', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7,
      uid: USER_UID,
      phone: null,
      role: 'DOCTOR',
      tenant_id: TENANT,
    }]);
    executeUnsafeMock.mockResolvedValueOnce(2);

    const result = await notificationService.markAllMineAsRead({
      uid: USER_UID,
      role: 'DOCTOR',
    });

    expect(result.updated_count).toBe(2);
    expect(executeUnsafeMock.mock.calls[0][0]).toMatch(/UPDATE notifications n/);
    expect(executeUnsafeMock.mock.calls[0][0]).toMatch(/n\.uid = \$1::uuid/);
    expect(executeUnsafeMock.mock.calls[0][0]).toMatch(/n\.user_id = \$2::int/);
    expect(executeUnsafeMock.mock.calls[0][0]).toMatch(/n\.tenant_id = \$3::uuid/);
  });
});
