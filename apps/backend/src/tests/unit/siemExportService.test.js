import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const readOnlyQueryUnsafeMock = jest.fn();
const warnMock = jest.fn();

const prismaMock = { $queryRawUnsafe: queryUnsafeMock };
const prismaReadOnlyMock = { $queryRawUnsafe: readOnlyQueryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  prismaReadOnly: prismaReadOnlyMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/ssrfGuard.js', () => ({
  safeFetch: jest.fn(),
}));

const {
  capturePendingSecurityAuditEvents,
  createSyntheticSecurityEvent,
  dispatchSiemDeliveries,
  normalizeSiemEvent,
  runSyntheticSiemDrill,
  upsertSiemExportTarget,
  __testing__,
} = await import('../../services/security/siemExportService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  readOnlyQueryUnsafeMock.mockReset();
  warnMock.mockReset();
});

function mockNext(rows) {
  queryUnsafeMock.mockResolvedValueOnce(rows);
}

describe('normalizeSiemEvent', () => {
  it('exports hashes and safe metadata without raw PHI fields', () => {
    const event = normalizeSiemEvent({
      tenant_id: TENANT,
      source_name: 'synthetic',
      source_id: 's1',
      event_type: 'SYNTHETIC_SECURITY_DRILL_CRITICAL',
      severity: 'critical',
      actor_uid: '11111111-1111-4111-8111-111111111111',
      subject_uid: '22222222-2222-4222-8222-222222222222',
      ip_address: '192.0.2.9',
      path: '/patients/123?phone=9999999999',
      metadata: {
        control_code: 'SIEM_ALERTS_ONCALL',
        patient_name: 'Jane Patient',
        phone: '+911234567890',
        clinical_payload: 'diagnosis text',
      },
    });

    const serialized = JSON.stringify(event.minimized_payload);
    expect(event.actor_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(event.subject_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(event.ip_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(event.minimized_payload.metadata.control_code).toBe('SIEM_ALERTS_ONCALL');
    expect(event.minimized_payload.redaction.raw_payload_exported).toBe(false);
    expect(event.minimized_payload.redaction.redacted_field_count).toBeGreaterThanOrEqual(3);
    expect(serialized).not.toContain('Jane Patient');
    expect(serialized).not.toContain('+911234567890');
    expect(serialized).not.toContain('diagnosis text');
    expect(serialized).not.toContain('/patients/123');
  });
});

describe('upsertSiemExportTarget', () => {
  it('rejects unsupported transports before touching the database', async () => {
    await expect(upsertSiemExportTarget({
      tenantId: TENANT,
      targetKey: 'bad',
      transport: 'ftp',
    })).rejects.toThrow(/transport must be one of/);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('createSyntheticSecurityEvent', () => {
  it('inserts a minimized critical synthetic event', async () => {
    mockNext([{ id: 10, source_name: 'synthetic', source_id: 'synthetic:x', severity: 'critical', minimized_payload: {} }]);

    await createSyntheticSecurityEvent({
      tenantId: TENANT,
      metadata: {
        patient_name: 'Raw Name',
        clinical_payload: 'Raw note',
      },
    });

    const insertCall = queryUnsafeMock.mock.calls[0];
    expect(String(insertCall[0])).toContain('INSERT INTO siem_export_events');
    const payload = JSON.parse(insertCall[15]);
    expect(payload.redaction.raw_payload_exported).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('Raw Name');
    expect(JSON.stringify(payload)).not.toContain('Raw note');
  });
});

describe('capturePendingSecurityAuditEvents', () => {
  it('reads audit_log through the read client, inserts events, and advances the cursor', async () => {
    mockNext([{ last_source_id: 41 }]);
    readOnlyQueryUnsafeMock.mockResolvedValueOnce([
      {
        id: 42,
        tenant_id: TENANT,
        action: 'BRUTE_FORCE_DETECTED',
        resource: 'auth',
        resource_id: 'admin-login',
        metadata: { reason: 'too many failures', phone: '+911234567890' },
        ip_address: '198.51.100.10',
        created_at: new Date('2026-07-08T00:00:00.000Z'),
        user_id: 7,
        user_role: 'ADMIN',
        method: 'POST',
        path: '/api/v1/auth/admin/login',
        module: 'security',
        status_code: 401,
        success: false,
        user_agent: 'test-agent',
      },
    ]);
    mockNext([{ id: 1, source_name: 'audit_log', source_id: '42', severity: 'critical', minimized_payload: {} }]);
    mockNext([]);

    const result = await capturePendingSecurityAuditEvents({ tenantId: TENANT, batchSize: 10 });
    expect(result.captured_count).toBe(1);
    expect(readOnlyQueryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(String(queryUnsafeMock.mock.calls.at(-1)[0])).toContain('INSERT INTO siem_export_cursors');
  });
});

describe('dispatchSiemDeliveries', () => {
  it('writes object-drop evidence and marks the attempt succeeded', async () => {
    const payload = {
      schema: 'vhhealth.siem.event.v1',
      source: { id: 'synthetic:one' },
      redaction: { raw_payload_exported: false },
    };
    mockNext([{
      id: 500,
      tenant_id: TENANT,
      event_id: 10,
      target_id: 20,
      transport: 'object_drop',
      attempt_number: 1,
      payload_snapshot: payload,
      payload_sha256: __testing__.hashPayload(payload),
      request_id: 'req',
    }]);
    mockNext([{
      id: 20,
      tenant_id: TENANT,
      target_key: 'object',
      transport: 'object_drop',
      status: 'active',
      object_drop_uri: 'D:/Dev/_codex/artifacts/scratch/test-siem',
      config: {},
    }]);
    mockNext([]);
    mockNext([]);
    const mkdirMock = jest.fn(async () => null);
    const writeFileMock = jest.fn(async () => null);

    const result = await dispatchSiemDeliveries({
      tenantId: TENANT,
      mkdirImpl: mkdirMock,
      writeFileImpl: writeFileMock,
    });

    expect(result).toEqual({ dispatched: 1, succeeded: 1, failed: 0, dead: 0 });
    expect(mkdirMock).toHaveBeenCalled();
    expect(writeFileMock.mock.calls[0][1]).toContain('"raw_payload_exported": false');
    expect(String(queryUnsafeMock.mock.calls[2][0])).toContain('UPDATE siem_export_delivery_attempts');
    expect(queryUnsafeMock.mock.calls[2][1]).toBe('succeeded');
  });

  it('records a retry row for retryable webhook failures', async () => {
    const payload = {
      schema: 'vhhealth.siem.event.v1',
      source: { id: 'audit:42' },
      redaction: { raw_payload_exported: false },
    };
    mockNext([{
      id: 501,
      tenant_id: TENANT,
      event_id: 11,
      target_id: 21,
      transport: 'webhook',
      attempt_number: 1,
      payload_snapshot: payload,
      payload_sha256: __testing__.hashPayload(payload),
      request_id: 'req',
    }]);
    mockNext([{
      id: 21,
      tenant_id: TENANT,
      target_key: 'hook',
      transport: 'webhook',
      status: 'active',
      endpoint_url: 'https://siem.example/hook',
      config: {},
    }]);
    mockNext([]);
    mockNext([]);
    mockNext([]);

    const result = await dispatchSiemDeliveries({
      tenantId: TENANT,
      fetchImpl: jest.fn(async () => ({ status: 503, text: async () => 'busy' })),
    });

    expect(result.failed).toBe(1);
    const retryInsert = queryUnsafeMock.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO siem_export_delivery_attempts')
      && call[5] === 2
    );
    expect(retryInsert).toBeTruthy();
  });
});

describe('runSyntheticSiemDrill', () => {
  it('creates a drill target, event, delivery, and compliance evidence metadata', async () => {
    mockNext([{ id: 20, tenant_id: TENANT, target_key: 'synthetic-object-drop', transport: 'object_drop', status: 'active' }]);
    mockNext([{ id: 10, source_name: 'synthetic', source_id: 'synthetic:x', severity: 'critical', minimized_payload: { redaction: { raw_payload_exported: false } } }]);
    mockNext([{
      id: 20,
      tenant_id: TENANT,
      target_key: 'synthetic-object-drop',
      transport: 'object_drop',
      status: 'active',
      min_severity: 'high',
    }]);
    mockNext([{
      id: 10,
      uid: 'event-uid',
      tenant_id: TENANT,
      event_type: 'SYNTHETIC_SECURITY_DRILL_CRITICAL',
      severity: 'critical',
      minimized_payload: { source: { id: 'synthetic:x' }, redaction: { raw_payload_exported: false } },
      payload_sha256: 'a'.repeat(64),
      created_at: new Date(),
    }]);
    mockNext([{ id: 100 }]);
    mockNext([]);
    mockNext([{
      id: 100,
      tenant_id: TENANT,
      event_id: 10,
      target_id: 20,
      transport: 'object_drop',
      attempt_number: 1,
      payload_snapshot: { source: { id: 'synthetic:x' }, redaction: { raw_payload_exported: false } },
      payload_sha256: 'a'.repeat(64),
      request_id: 'req',
    }]);
    mockNext([{
      id: 20,
      tenant_id: TENANT,
      target_key: 'synthetic-object-drop',
      transport: 'object_drop',
      status: 'active',
      object_drop_uri: 'D:/Dev/_codex/artifacts/scratch/test-siem',
      config: {},
    }]);
    mockNext([]);
    mockNext([]);
    mockNext([{ id: 100, status: 'succeeded', evidence_uri: 'D:/x.json' }]);
    mockNext([]);
    mockNext([]);

    const result = await runSyntheticSiemDrill({
      tenantId: TENANT,
      objectDropDir: 'D:/Dev/_codex/artifacts/scratch/test-siem',
      mkdirImpl: jest.fn(async () => null),
      writeFileImpl: jest.fn(async () => null),
    });

    expect(result.dispatch.succeeded).toBe(1);
    expect(String(queryUnsafeMock.mock.calls.at(-2)[0])).toContain('UPDATE india_compliance_evidence');
  });
});
