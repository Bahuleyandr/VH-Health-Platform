import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const dispatchMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();
const emitVitalAnomalyMock = jest.fn();
const emitCodeBlueMock = jest.fn();

const prismaMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: dispatchMock,
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitVitalAnomaly: emitVitalAnomalyMock,
  emitCodeBlue: emitCodeBlueMock,
}));

jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

const { checkVitalAnomalies } = await import('../../utils/clinical/vitalSignMonitor.js');

const PATIENT_ID = 4321;
const PATIENT_UID = '11111111-2222-4333-8444-555555555555';
const PATIENT_TENANT = '22222222-2222-4222-8222-222222222222';

describe('checkVitalAnomalies device-source policy', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    setTenantTxMock.mockReset();
    dispatchMock.mockReset();
    enqueueCriticalResultTaskMock.mockReset();
    emitVitalAnomalyMock.mockReset();
    emitCodeBlueMock.mockReset();
    setTenantTxMock.mockImplementation((_tenantId, fn) => fn(prismaMock));
    enqueueCriticalResultTaskMock.mockResolvedValue({ created: true, taskId: 1 });
    queryRawMock.mockResolvedValue([]);
    executeRawMock.mockResolvedValue(1);
  });

  it('does not persist or fan out an uncorroborated device artifact breach', async () => {
    queryRawMock.mockResolvedValueOnce([{ age_years: 55, is_pregnant: false }]);

    const alerts = await checkVitalAnomalies(
      PATIENT_ID,
      { oxygen_saturation: 80 },
      {
        source: 'device',
        recordedBy: 'device-service-principal',
        artifactVerdicts: {
          oxygen_saturation: { corroborated: false, required: 2, window: 3 },
        },
      },
    );

    expect(alerts).toEqual([]);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
  });

  it('suppresses an unacknowledged repeat device alert inside the configured window', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ age_years: 55, is_pregnant: false }])
      .mockResolvedValueOnce([{ id: 99 }]);

    const alerts = await checkVitalAnomalies(
      PATIENT_ID,
      { oxygen_saturation: 80 },
      {
        source: 'device',
        recordedBy: 'device-service-principal',
        suppressRepeats: true,
        suppressionWindows: { CRITICAL: 10 },
      },
    );

    expect(alerts).toEqual([]);
    expect(queryRawMock.mock.calls[1][0]).toContain('acknowledged_at IS NULL');
    expect(queryRawMock.mock.calls[1][4]).toBe(10);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('re-arms after acknowledgement and skips recorded_by push for device CRITICAL alerts', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ age_years: 55, is_pregnant: false }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ uid: PATIENT_UID, tenant_id: PATIENT_TENANT }])
      .mockResolvedValueOnce([{ id: 7001 }]);

    const alerts = await checkVitalAnomalies(
      PATIENT_ID,
      { oxygen_saturation: 80 },
      {
        source: 'device',
        recordedBy: 'device-service-principal',
        suppressRepeats: true,
        suppressionWindows: { CRITICAL: 10 },
      },
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ vital_name: 'oxygen_saturation', severity: 'CRITICAL' });
    expect(setTenantTxMock).toHaveBeenCalledWith(PATIENT_TENANT, expect.any(Function));
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: PATIENT_TENANT,
      patientUid: PATIENT_UID,
      resourceId: 7001,
      source: 'vital_alert',
    }));
  });
});
