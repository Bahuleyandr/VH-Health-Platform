import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../config/tenantRlsConfig.js', () => ({
  isDefaultTenantAllowed: () => false,
}));

const {
  createQueueDisplayProfile,
  getQueueDisplayBoard,
  updateQueueDisplaySettings,
} = await import('../../services/appointment/queueDisplayService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

afterEach(() => {
  prismaMock.$queryRawUnsafe.mockReset();
});

describe('queueDisplayService', () => {
  it('locks display profiles to token-only identity', async () => {
    await expect(createQueueDisplayProfile(TENANT_ID, {
      displayName: 'OP TV',
      maskedNamePolicy: 'initials',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'QUEUE_DISPLAY_TOKEN_ONLY',
    });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('stores per-tenant display settings with explicit tenant id', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{
      enabled: true,
      poll_interval_seconds: 20,
      max_items: 10,
      eta_buckets_enabled: false,
      default_language_code: 'en',
      default_accessibility_size: 'large',
      enabled_at: new Date('2026-07-08T00:00:00Z'),
      enabled_by: '11111111-1111-4111-8111-111111111111',
      acceptance_snapshot: { approvedBy: 'ops' },
      updated_by: '11111111-1111-4111-8111-111111111111',
      created_at: new Date('2026-07-08T00:00:00Z'),
      updated_at: new Date('2026-07-08T00:00:00Z'),
    }]);

    const settings = await updateQueueDisplaySettings(TENANT_ID, {
      enabled: true,
      pollIntervalSeconds: 20,
      maxItems: 10,
      defaultAccessibilitySize: 'large',
      acceptanceSnapshot: { approvedBy: 'ops' },
    }, {
      actorUid: '11111111-1111-4111-8111-111111111111',
    });

    expect(settings).toEqual(expect.objectContaining({
      enabled: true,
      pollIntervalSeconds: 20,
      maxItems: 10,
      defaultAccessibilitySize: 'large',
    }));
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('queue_display_settings');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][1]).toBe(TENANT_ID);
  });

  it('returns a PHI-free token board payload', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{
        enabled: true,
        poll_interval_seconds: 15,
        max_items: 12,
        eta_buckets_enabled: false,
        default_language_code: 'en',
        default_accessibility_size: 'standard',
      }])
      .mockResolvedValueOnce([{
        id: 5,
        profile_key: 'op-tv',
        display_name: 'OP TV',
        location_label: 'Ground floor',
        facility_id: null,
        department_id: 3,
        doctor_id: null,
        queue_kind: 'department',
        queue_label_override: 'Cardiology',
        counter_label: 'Counter 2',
        display_mode: 'token_board',
        language_code: 'en',
        accessibility_size: 'large',
        contrast_mode: 'high',
        motion_mode: 'reduced',
        audio_announcements_enabled: false,
        masked_name_policy: 'token_only',
        is_active: true,
      }])
      .mockResolvedValueOnce([{
        appointment_id: 99,
        queue_label: 'Cardiology',
        token_display: 'A-12',
        room_or_counter: 'Counter 2',
        display_status: 'waiting',
        appointment_time: '10:30',
        appointment_date: '2026-07-08',
        last_updated_at: new Date('2026-07-08T05:00:00Z'),
      }]);

    const board = await getQueueDisplayBoard(TENANT_ID, 5, { date: '2026-07-08' });

    expect(board.items).toEqual([expect.objectContaining({
      appointmentId: 99,
      queueLabel: 'Cardiology',
      tokenDisplay: 'A-12',
      roomOrCounter: 'Counter 2',
      displayStatus: 'waiting',
    })]);
    expect(board.phiPolicy.identity).toBe('token_only');
    const serialized = JSON.stringify(board);
    expect(serialized).not.toMatch(/patientName|patient_name|phone|patientUid|patient_uid|diagnosis|reason|notes/i);
  });

  it('fails closed when tenant displays are disabled', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 5,
        profile_key: 'op-tv',
        display_name: 'OP TV',
        display_mode: 'token_board',
        language_code: 'en',
        accessibility_size: 'standard',
        contrast_mode: 'standard',
        motion_mode: 'standard',
        audio_announcements_enabled: false,
        masked_name_policy: 'token_only',
        is_active: true,
      }]);

    await expect(getQueueDisplayBoard(TENANT_ID, 5)).rejects.toMatchObject({
      statusCode: 403,
      code: 'QUEUE_DISPLAY_DISABLED',
    });
  });
});
