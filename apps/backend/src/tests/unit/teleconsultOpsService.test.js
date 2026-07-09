import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const prismaMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
}));

const {
  TELECONSULT_OPS_TELEMETRY_FIELDS,
  assertTeleconsultOpsTelemetryAllowlist,
  getTeleconsultOpsSnapshot,
} = await import('../../services/dashboards/teleconsultOpsService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

describe('teleconsult ops snapshot service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryRawUnsafeMock.mockResolvedValue([{
      teleconsult_count: 12,
      active_count: 3,
      waiting_count: 2,
      scheduled_count: 4,
      terminal_count: 6,
      video_session_count: 5,
      join_failure_count: 1,
      turn_session_count: 4,
      turn_usage_rate_pct: '80.0',
      consent_recorded_count: 9,
      consent_recorded_rate_pct: '75.0',
      status_counts: { waiting: 2, in_progress: 3 },
      video_session_counts: { active: 3, failed: 1 },
      provider_counts: { livekit: 5 },
      final_modality_distribution: { video: 5, audio: 1 },
    }]);
  });

  test('binds tenant_id before the window parameter and returns only allowlisted fields', async () => {
    const snapshot = await getTeleconsultOpsSnapshot({ tenantId: TENANT_ID, windowHours: 999 });

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).toMatch(/tc\.tenant_id = \$1::uuid/);
    expect(call[0]).toMatch(/vs\.tenant_id = \$1::uuid/);
    expect(call.slice(1)).toEqual([TENANT_ID, 168]);
    expect(Object.keys(snapshot).sort()).toEqual([...TELECONSULT_OPS_TELEMETRY_FIELDS].sort());
    expect(snapshot).not.toHaveProperty('patient_uid');
    expect(snapshot).not.toHaveProperty('doctor_uid');
    expect(snapshot).not.toHaveProperty('patient_join_url');
    expect(snapshot.turn_usage_rate_pct).toBe(80);
  });

  test('rejects unexpected PHI-style telemetry fields', () => {
    expect(() => assertTeleconsultOpsTelemetryAllowlist({
      generated_at: '2026-07-02T08:00:00.000Z',
      patient_uid: 'x',
    })).toThrow(/unexpected field/);
  });
});
