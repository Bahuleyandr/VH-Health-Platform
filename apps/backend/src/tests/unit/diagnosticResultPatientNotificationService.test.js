import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const GENERATION_ID = '20000000-0000-4000-8000-000000000001';
const PATIENT_UID = '30000000-0000-4000-8000-000000000001';

const queryMock = jest.fn();
const feedReceiptMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback({
  $queryRawUnsafe: queryMock,
}));
const modeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn() },
}));
jest.unstable_mockModule('../../utils/notifications/patientNotificationFeed.js', () => ({
  recordPatientFeedNotificationWithReceipt: feedReceiptMock,
}));
jest.unstable_mockModule('../../services/pathways/pathwayRuntimePersistence.js', () => ({
  resolvePathwayModeTx: modeMock,
}));
jest.unstable_mockModule('../../services/portal/portalAccessService.js', () => ({
  releaseDelayHours: () => 24,
  structuredDiagnosticReleaseVisibilitySql: () => 'TRUE',
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: (value) => value,
}));

const { runStructuredDiagnosticPatientNotificationSweep } = await import(
  '../../services/diagnostics/diagnosticResultPatientNotificationService.js'
);

describe('structured diagnostic patient notifications', () => {
  beforeEach(() => {
    queryMock.mockReset();
    modeMock.mockReset();
    feedReceiptMock.mockReset();
    feedReceiptMock.mockResolvedValue({ written: true, notificationId: 73 });
  });

  test('is inert in shadow mode even when the tenant enabled notifications', async () => {
    modeMock.mockResolvedValue('shadow');
    queryMock.mockResolvedValueOnce([{ notification_mode: 'enabled' }]);

    await expect(runStructuredDiagnosticPatientNotificationSweep({
      tenantId: TENANT_ID,
    })).resolves.toMatchObject({
      pathway_mode: 'shadow',
      notifications_enabled: true,
      candidates: 0,
      queued: 0,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  test('queues one PHI-free intent and receipt atomically for an eligible generation', async () => {
    modeMock.mockResolvedValue('active');
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('AS pathway_mode') && text.includes('FOR SHARE')) {
        return [{ pathway_mode: 'active', notification_mode: 'enabled' }];
      }
      if (text.includes("settings #>>")) return [{ notification_mode: 'enabled' }];
      if (text.includes('pg_advisory_xact_lock')) return [{}];
      if (text.includes('SELECT generation.id, generation.patient_uid')) {
        return [{ id: GENERATION_ID, patient_uid: PATIENT_UID, phone: '+919000000001' }];
      }
      if (text.includes('SELECT generation.id') && text.includes('ORDER BY generation.signed_at')) {
        return [{ id: GENERATION_ID }];
      }
      if (text.includes('INSERT INTO notification_outbox')) return [{ id: 41 }];
      if (text.includes('INSERT INTO diagnostic_result_patient_notifications')) {
        return [{ id: 9n, notification_outbox_id: 41 }];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(runStructuredDiagnosticPatientNotificationSweep({
      tenantId: TENANT_ID,
    })).resolves.toMatchObject({
      pathway_mode: 'active',
      notifications_enabled: true,
      candidates: 1,
      queued: 1,
      deferred: 0,
      errors: 0,
    });
    const outboxSql = queryMock.mock.calls.find(([sql]) => (
      String(sql).includes('INSERT INTO notification_outbox')
    ))?.[0];
    expect(outboxSql).toContain("'New report available'");
    expect(outboxSql).toContain("'route', '/portal/diagnostic-results'");
    expect(outboxSql).not.toMatch(/critical|abnormal|pathology|radiology/i);
    expect(feedReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
      client: expect.objectContaining({ $queryRawUnsafe: queryMock }),
      tenantId: TENANT_ID,
      uid: PATIENT_UID,
      type: 'diagnostic_result_ready',
      data: {
        generation_id: GENERATION_ID,
        route: '/portal/diagnostic-results',
      },
    }));
    const outboxCall = queryMock.mock.calls.find(([sql]) => (
      String(sql).includes('INSERT INTO notification_outbox')
    ));
    expect(outboxCall.slice(1)).toEqual([
      TENANT_ID,
      PATIENT_UID,
      '+919000000001',
      '__feed_notification_id',
      73,
      GENERATION_ID,
    ]);
    expect(queryMock.mock.calls.some(([sql]) => (
      String(sql).includes('INSERT INTO diagnostic_result_patient_notifications')
    ))).toBe(true);
  });

  test('aborts the atomic queue when the readable feed row is not confirmed', async () => {
    modeMock.mockResolvedValue('active');
    feedReceiptMock.mockResolvedValue({ written: false, notificationId: null });
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('AS pathway_mode') && text.includes('FOR SHARE')) {
        return [{ pathway_mode: 'active', notification_mode: 'enabled' }];
      }
      if (text.includes("settings #>>")) return [{ notification_mode: 'enabled' }];
      if (text.includes('pg_advisory_xact_lock')) return [{}];
      if (text.includes('SELECT generation.id, generation.patient_uid')) {
        return [{ id: GENERATION_ID, patient_uid: PATIENT_UID, phone: '+919000000001' }];
      }
      if (text.includes('SELECT generation.id') && text.includes('ORDER BY generation.signed_at')) {
        return [{ id: GENERATION_ID }];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(runStructuredDiagnosticPatientNotificationSweep({
      tenantId: TENANT_ID,
    })).resolves.toMatchObject({
      candidates: 1,
      queued: 0,
      deferred: 0,
      errors: 1,
    });
    expect(queryMock.mock.calls.some(([sql]) => (
      String(sql).includes('INSERT INTO notification_outbox')
    ))).toBe(false);
    expect(queryMock.mock.calls.some(([sql]) => (
      String(sql).includes('INSERT INTO diagnostic_result_patient_notifications')
    ))).toBe(false);
  });

  test('does not queue when the explicit tenant notification policy is absent', async () => {
    modeMock.mockResolvedValue('active');
    queryMock.mockResolvedValueOnce([{ notification_mode: null }]);

    await expect(runStructuredDiagnosticPatientNotificationSweep({
      tenantId: TENANT_ID,
    })).resolves.toMatchObject({
      notifications_enabled: false,
      candidates: 0,
      queued: 0,
    });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  test('rechecks and locks rollout policy before queueing a listed candidate', async () => {
    modeMock.mockResolvedValue('active');
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('AS pathway_mode') && text.includes('FOR SHARE')) {
        return [{ pathway_mode: 'shadow', notification_mode: 'enabled' }];
      }
      if (text.includes("settings #>>")) return [{ notification_mode: 'enabled' }];
      if (text.includes('ORDER BY generation.signed_at')) return [{ id: GENERATION_ID }];
      if (text.includes('pg_advisory_xact_lock')) return [{}];
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(runStructuredDiagnosticPatientNotificationSweep({
      tenantId: TENANT_ID,
    })).resolves.toMatchObject({
      candidates: 1,
      queued: 0,
      deferred: 1,
      errors: 0,
    });
    expect(queryMock.mock.calls.some(([sql]) => (
      String(sql).includes('INSERT INTO notification_outbox')
    ))).toBe(false);
  });
});
