import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();

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

jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: sendStaffNotificationsMock,
}));

const { notificationService } = await import('../../services/notification/notificationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER_UID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset();
  sendStaffNotificationsMock.mockReset();
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
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        uid: USER_UID,
        phone: null,
        role: 'DOCTOR',
        tenant_id: TENANT,
      }])
      .mockResolvedValueOnce([
        { notification_id: 10 },
        { notification_id: 11 },
      ]);

    const result = await notificationService.markAllMineAsRead({
      uid: USER_UID,
      role: 'DOCTOR',
    });

    expect(result.updated_count).toBe(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/WITH updated AS/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/UPDATE notifications n/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO notification_events/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/n\.uid = \$1::uuid/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/n\.user_id = \$2::int/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/n\.tenant_id = \$3::uuid/);
  });

  it('acknowledges a notification and records an acknowledgement event', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        uid: USER_UID,
        phone: null,
        role: 'NURSING_STAFF',
        tenant_id: TENANT,
      }])
      .mockResolvedValueOnce([{
        id: 99,
        tenant_id: TENANT,
        uid: USER_UID,
        user_id: 7,
        title: 'Critical lab alert',
        type: 'LAB_CRITICAL_ALERT',
        priority: 'HIGH',
        related_id: 12,
        is_read: true,
        read_at: new Date('2026-06-03T00:05:00.000Z'),
      }])
      .mockResolvedValueOnce([{
        id: 500,
        notification_id: 99,
        event_type: 'acknowledged',
      }]);

    const result = await notificationService.acknowledgeNotification(
      99,
      { uid: USER_UID, role: 'NURSING_STAFF' },
    );

    expect(result.id).toBe(99);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/INSERT INTO notification_events/);
    expect(queryUnsafeMock.mock.calls[2][3]).toBe('acknowledged');
    expect(queryUnsafeMock.mock.calls[2][5]).toBe('NURSING_STAFF');
  });

  it('escalates unread critical notifications once and fans out to admins', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 501,
      tenant_id: TENANT,
      notification_id: 99,
      notification_type: 'LAB_CRITICAL_ALERT',
      notification_priority: 'HIGH',
      related_id: 12,
      metadata: { title: 'Critical lab alert' },
      created_at: new Date('2026-06-03T00:30:00.000Z'),
    }]);
    sendStaffNotificationsMock.mockResolvedValueOnce({ notification_count: 2 });

    const result = await notificationService.runUnreadCriticalEscalation({
      ageMinutes: 15,
    });

    expect(result.escalated_count).toBe(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/NOT EXISTS/);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/auto_escalated/);
    expect(sendStaffNotificationsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      recipientRoles: ['ADMIN', 'SUPER_ADMIN'],
      type: 'CRITICAL_ALERT_ESCALATION',
      priority: 'HIGH',
    }));
  });

  it('creates notifications only for recipients in the actor tenant', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 10,
        uid: USER_UID,
        name: 'Tenant Patient',
        phone: '+911234567890',
        role: 'PATIENT',
        tenant_id: TENANT,
      }])
      .mockResolvedValueOnce([{
        id: 300,
        uid: USER_UID,
        user_id: 10,
        phone: '+911234567890',
        title: 'Follow up',
        message: 'Please review',
        type: 'SYSTEM',
        priority: 'MEDIUM',
        data: null,
        is_read: false,
        created_at: new Date('2026-06-03T00:00:00.000Z'),
      }]);

    await notificationService.createNotification(
      { user_id: 10, title: 'Follow up', message: 'Please review' },
      { uid: USER_UID, role: 'ADMIN', tenantId: TENANT },
    );

    const [lookupSql, ...lookupParams] = queryUnsafeMock.mock.calls[0];
    expect(lookupSql).toContain('tenant_id = $2::uuid');
    expect(lookupParams).toEqual([10, TENANT]);
    const [insertSql, tenantParam] = queryUnsafeMock.mock.calls[1];
    expect(insertSql).toContain('INSERT INTO notifications');
    expect(tenantParam).toBe(TENANT);
  });

  it('bulk sends only to users in the actor tenant', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([
        { id: 10, uid: USER_UID, name: 'Tenant Patient', phone: '+911234567890', tenant_id: TENANT },
      ])
      .mockResolvedValueOnce([{ id: 301, uid: USER_UID, user_id: 10 }]);

    const result = await notificationService.sendBulkNotifications(
      { user_ids: [10], title: 'Notice', message: 'Tenant scoped' },
      { uid: USER_UID, role: 'ADMIN', tenantId: TENANT },
    );

    expect(result.notifications_sent).toBe(1);
    const [lookupSql, ...lookupParams] = queryUnsafeMock.mock.calls[0];
    expect(lookupSql).toContain('id = ANY($1::int[])');
    expect(lookupSql).toContain('tenant_id = $2::uuid');
    expect(lookupParams).toEqual([[10], TENANT]);
  });

  it('scopes notification stats queries to the actor tenant', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ total_notifications: 0, unread_notifications: 0, read_notifications: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await notificationService.getNotificationStats(7, { uid: USER_UID, role: 'ADMIN', tenantId: TENANT });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(4);
    for (const [sql, days, tenantId] of queryUnsafeMock.mock.calls) {
      expect(sql).toContain('tenant_id = $2::uuid');
      expect(days).toBe(7);
      expect(tenantId).toBe(TENANT);
    }
  });
});
