import { jest } from '@jest/globals';

const queryMock = jest.fn();
const executeMock = jest.fn();
const tx = { $queryRawUnsafe: queryMock, $executeRawUnsafe: executeMock };
const setTenantMock = jest.fn(async (_tenantId, apply) => apply(tx));
const setTenantTxMock = jest.fn(async (_tenantId, apply) => apply(tx));
const persistCdsAlertMock = jest.fn();
const queueMock = jest.fn();
const registerExposureHandlerMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenant: setTenantMock,
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(), logPhiAccessBatch: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: queueMock },
}));
jest.unstable_mockModule('../../services/emr/cdsEngine.js', () => ({
  persistCdsAlert: persistCdsAlertMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId,
}));
jest.unstable_mockModule('../../services/clinical/bloodborneMarkerService.js', () => ({
  DEFAULT_VALIDITY_DAYS: 90,
  MARKERS: ['hiv', 'hbsag', 'hcv', 'cjd_suspected', 'other'],
  registerExposureHandler: registerExposureHandlerMock,
  resolveReuseStatus: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordMedicationSafetyReviews: jest.fn(),
}));

const { quarantineDevicesExposedToPatient } = await import('../../services/clinical/cathDeviceReuseService.js');
const registrations = [...registerExposureHandlerMock.mock.calls];
const TENANT = '10000000-0000-4000-8000-000000000001';
const event = {
  tenantId: TENANT,
  patientUid: '10000000-0000-4000-8000-000000000002',
  marker: 'hcv', testedOn: '2026-09-07', markerRowId: 101,
};
const device = {
  id: 11, tenant_id: TENANT, device_tag: 'RP00000011',
  catalog_item_id: 5, origin_usage_id: 6, facility_id: 1,
  cycle_count: 1, max_cycles_snapshot: 5, current_usage_id: null,
  status: 'available', exposure_markers: [],
};
let candidates;
let officers;
let failedDeviceIds;
let discoveryError;
let devices;

beforeEach(() => {
  jest.clearAllMocks();
  candidates = [{ id: device.id }];
  officers = [{ id: 21, uid: 'officer-one' }, { id: 22, uid: 'officer-two' }];
  failedDeviceIds = new Set();
  discoveryError = null;
  devices = new Map([[device.id, { ...device }]]);
  persistCdsAlertMock.mockReset().mockResolvedValue({ persisted: true });
  queueMock.mockReset().mockResolvedValue({ id: 301 });
  executeMock.mockResolvedValue(1);
  queryMock.mockImplementation(async (sql, ...params) => {
    if (sql.includes('FROM cath_reprocessing_settings')) return [];
    if (sql.includes('SELECT DISTINCT d.id')) return candidates;
    if (sql.includes('FROM users')) {
      if (discoveryError) throw discoveryError;
      return officers;
    }
    if (sql.includes('FOR UPDATE OF d')) {
      if (failedDeviceIds.has(params[1])) throw new Error('device lock failed');
      return [devices.get(params[1])];
    }
    if (sql.includes('UPDATE cath_reprocessable_devices d')) {
      devices.get(params[1]).status = params[2];
      return [{ id: params[1] }];
    }
    throw new Error(`Unexpected cath exposure query: ${sql}`);
  });
});

describe('cath exposure delivery compatibility', () => {
  test('registers its stable cath-only handler identity', () => {
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toEqual([{
      id: 'cath-device-reuse.v1', apply: quarantineDevicesExposedToPatient,
    }]);
  });

  test('uses an unbounded null-date lookback inside the tenant and patient predicates', async () => {
    const result = await quarantineDevicesExposedToPatient({ ...event, testedOn: null });
    const candidateQueries = queryMock.mock.calls.filter(([sql]) => sql.includes('SELECT DISTINCT d.id'));
    expect(candidateQueries).toHaveLength(1);
    const [sql, ...params] = candidateQueries[0];
    expect(sql).toContain('WHERE d.tenant_id = $1::uuid');
    expect(sql).toContain('AND u.patient_uid = $2::uuid');
    expect(sql.replace(/\s+/g, ' ')).toContain("AND ($3::date IS NULL OR u.used_at >= (($3::date - ($4::int * INTERVAL '1 day'))::timestamp AT TIME ZONE 'Asia/Kolkata'))");
    expect(params).toEqual([TENANT, event.patientUid, null, 90]);
    expect(result.affected).toHaveLength(1);
  });

  test('reports zero obligations only after durable alert and notification intent success', async () => {
    expect(candidates).toHaveLength(1);
    expect(officers).toHaveLength(2);
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result.affected).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(result).toMatchObject({
      remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 0,
    });
    expect(persistCdsAlertMock).toHaveBeenCalledTimes(1);
    expect(persistCdsAlertMock).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'bloodborne_reuse_exposure', patientUid: event.patientUid,
      sourceData: { marker: 'hcv', tested_on: event.testedOn, device_ids: [11], marker_row_id: 101 },
    }));
    expect(queueMock).toHaveBeenCalledTimes(2);
    expect(queueMock.mock.calls.map(([notification]) => notification.sourceEventKey)).toEqual([
      'bloodborne-reuse-exposure:101:officer-one', 'bloodborne-reuse-exposure:101:officer-two',
    ]);
  });

  test('retains an alert obligation when persistence resolves false', async () => {
    persistCdsAlertMock.mockResolvedValue({ persisted: false, reason: 'persist_failed' });
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result).toMatchObject({
      remaining_device_count: 0, remaining_alert_count: 1, remaining_notification_count: 0,
    });
    expect(queueMock).toHaveBeenCalledTimes(2);
  });

  test('retains an alert obligation on rejection and still queues notifications', async () => {
    persistCdsAlertMock.mockRejectedValue(new Error('alert unavailable'));
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result).toMatchObject({
      remaining_device_count: 0, remaining_alert_count: 1, remaining_notification_count: 0,
    });
    expect(queueMock).toHaveBeenCalledTimes(2);
  });

  test('retains each null notification result and continues later recipients', async () => {
    queueMock.mockResolvedValueOnce(null);
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result).toMatchObject({
      remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 1,
    });
    expect(queueMock).toHaveBeenCalledTimes(2);
    expect(queueMock.mock.calls.map(([notification]) => notification.recipientId)).toEqual([21, 22]);
  });

  test('retains each rejected notification and continues later recipients', async () => {
    queueMock.mockRejectedValueOnce(new Error('notification unavailable'));
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result).toMatchObject({
      remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 1,
    });
    expect(queueMock).toHaveBeenCalledTimes(2);
    expect(queueMock.mock.calls.map(([notification]) => notification.recipientId)).toEqual([21, 22]);
  });

  test('retains unresolved recipient discovery as notification work', async () => {
    discoveryError = new Error('officer discovery unavailable');
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result).toMatchObject({
      remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 1,
    });
    expect(queueMock).not.toHaveBeenCalled();
  });

  test('reports device failures even when no device settles', async () => {
    expect(candidates).toHaveLength(1);
    failedDeviceIds.add(11);
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result).toEqual({
      affected: [], failed: [{ device_id: 11, error: 'device lock failed' }],
      remaining_device_count: 1, remaining_alert_count: 0, remaining_notification_count: 0,
    });
    expect(persistCdsAlertMock).not.toHaveBeenCalled();
    expect(queueMock).not.toHaveBeenCalled();
  });

  test('reports partial device failure while delivering settled-device notifications', async () => {
    candidates = [{ id: 11 }, { id: 12 }];
    expect(candidates).toHaveLength(2);
    failedDeviceIds.add(12);
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result.affected).toHaveLength(1);
    expect(result.failed).toEqual([{ device_id: 12, error: 'device lock failed' }]);
    expect(result).toMatchObject({
      remaining_device_count: 1, remaining_alert_count: 0, remaining_notification_count: 0,
    });
    expect(persistCdsAlertMock).toHaveBeenCalledTimes(1);
    expect(queueMock).toHaveBeenCalledTimes(2);
  });

  test('reports an explicit completed result when no candidate exists', async () => {
    candidates = [];
    const result = await quarantineDevicesExposedToPatient(event);
    expect(result).toEqual({
      affected: [], failed: [],
      remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 0,
    });
    expect(persistCdsAlertMock).not.toHaveBeenCalled();
    expect(queueMock).not.toHaveBeenCalled();
  });

  test('retries failed notification intent after the affected device is no longer a candidate', async () => {
    expect(candidates).toHaveLength(1);
    queueMock.mockResolvedValueOnce(null);
    const previousResult = await quarantineDevicesExposedToPatient(event);
    expect(previousResult.affected).toHaveLength(1);
    expect(previousResult.remaining_notification_count).toBe(1);
    candidates = [];
    queueMock.mockClear();
    setTenantTxMock.mockClear();
    const result = await quarantineDevicesExposedToPatient(event, { previousResult });
    expect(result.affected).toEqual([{ id: 11, device_tag: 'RP00000011' }]);
    expect(result).toMatchObject({
      remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 0,
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queueMock).toHaveBeenCalledTimes(2);
    expect(queueMock.mock.calls[0][0].data.device_ids).toEqual([11]);
    expect(queueMock.mock.calls[0][0].body).toContain('RP00000011');
  });

  test('retries failed alert after the affected device is no longer a candidate', async () => {
    expect(candidates).toHaveLength(1);
    persistCdsAlertMock.mockResolvedValueOnce({ persisted: false });
    const previousResult = await quarantineDevicesExposedToPatient(event);
    expect(previousResult.affected).toHaveLength(1);
    expect(previousResult.remaining_alert_count).toBe(1);
    candidates = [];
    persistCdsAlertMock.mockClear();
    setTenantTxMock.mockClear();
    const result = await quarantineDevicesExposedToPatient(event, { previousResult });
    expect(result.affected).toEqual([{ id: 11, device_tag: 'RP00000011' }]);
    expect(result.remaining_alert_count).toBe(0);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(persistCdsAlertMock).toHaveBeenCalledTimes(1);
    expect(persistCdsAlertMock.mock.calls[0][0].sourceData.device_ids).toEqual([11]);
  });

  test('retries failed recipient discovery with no current candidates', async () => {
    discoveryError = new Error('officer discovery unavailable');
    const previousResult = await quarantineDevicesExposedToPatient(event);
    expect(previousResult.affected).toHaveLength(1);
    expect(previousResult.remaining_notification_count).toBe(1);
    expect(queueMock).not.toHaveBeenCalled();
    discoveryError = null;
    candidates = [];
    setTenantTxMock.mockClear();
    const result = await quarantineDevicesExposedToPatient(event, { previousResult });
    expect(result.remaining_notification_count).toBe(0);
    expect(result.affected).toEqual([{ id: 11, device_tag: 'RP00000011' }]);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queueMock).toHaveBeenCalledTimes(2);
  });

  test('merges prior effect identities with current settled devices once in ID order', async () => {
    const previousResult = {
      affected: [
        { id: 13, device_tag: 'RP00000013' },
        { id: '11', device_tag: 'RP00000011' },
        { id: 9, device_tag: 'RP00000009' },
      ],
      remaining_alert_count: 1, remaining_notification_count: 0,
    };
    expect(previousResult.affected).toHaveLength(3);
    expect(candidates).toHaveLength(1);
    const result = await quarantineDevicesExposedToPatient(event, { previousResult });
    expect(result.affected).toHaveLength(3);
    expect(result.affected.map(entry => entry.id)).toEqual([9, 11, 13]);
    expect(result.affected[1].status).toBe('quarantined');
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(persistCdsAlertMock).toHaveBeenCalledTimes(1);
    expect(persistCdsAlertMock.mock.calls[0][0].sourceData.device_ids).toEqual([9, 11, 13]);
  });

  test('ignores completed previous effects when no candidate remains', async () => {
    const previousResult = await quarantineDevicesExposedToPatient(event);
    expect(previousResult.affected).toHaveLength(1);
    expect(previousResult.remaining_alert_count).toBe(0);
    expect(previousResult.remaining_notification_count).toBe(0);
    candidates = [];
    persistCdsAlertMock.mockClear();
    queueMock.mockClear();
    const result = await quarantineDevicesExposedToPatient(event, { previousResult });
    expect(result.affected).toEqual([]);
    expect(persistCdsAlertMock).not.toHaveBeenCalled();
    expect(queueMock).not.toHaveBeenCalled();
  });

  test('retries a dispatcher failure result that has no prior affected population', async () => {
    const previousResult = {
      remaining_device_count: 1, remaining_alert_count: 1, remaining_notification_count: 1,
    };
    expect(candidates).toHaveLength(1);
    const result = await quarantineDevicesExposedToPatient(event, { previousResult });
    expect(result.affected).toHaveLength(1);
    expect(result).toMatchObject({
      remaining_device_count: 0, remaining_alert_count: 0, remaining_notification_count: 0,
    });
    expect(persistCdsAlertMock).toHaveBeenCalledTimes(1);
    expect(queueMock).toHaveBeenCalledTimes(2);
  });
});
