import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const setTenantTxMock = jest.fn(async (tenantId, fn) => fn({
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
  __tenantId: tenantId,
}));
const queueNotificationMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawMock, $executeRawUnsafe: executeRawMock },
  setTenantTx: setTenantTxMock,
  setTenant: setTenantTxMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: { queue: queueNotificationMock },
  notificationOutbox: { queue: queueNotificationMock },
}));

jest.unstable_mockModule('../../services/ai/biomedDeviceMaintenanceService.js', () => ({
  DEFAULT_SERVICE_INTERVALS_HOURS: {
    ventilator: 1000,
    infusion_pump: 2000,
    other: 2000,
  },
}));

const service = await import('../../services/biomed/biomedCmmsService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER_UID = '11111111-2222-4333-8444-000000000001';

function workOrder(extra = {}) {
  return {
    id: 900,
    tenant_id: TENANT,
    work_order_number: 'BWO-20260707-000900',
    biomed_device_id: 42,
    schedule_id: null,
    kind: 'preventive',
    priority: 'normal',
    status: 'open',
    description: 'Preventive maintenance due',
    assigned_to_id: null,
    assigned_to_uid: null,
    assigned_to_role: 'BIOMEDICAL_STAFF',
    assigned_vendor: null,
    assigned_at: null,
    sla_due_at: '2026-07-08T00:00:00.000Z',
    sla_breached_at: null,
    completion_notes: null,
    parts_used: [],
    cost_amount: null,
    downtime_started_at: null,
    downtime_ended_at: null,
    completed_at: null,
    verified_at: null,
    source: 'schedule',
    source_ref: 'schedule:7',
    due_window_start: '2026-07-07T00:00:00.000Z',
    due_window_end: null,
    created_by: null,
    created_at: '2026-07-07T00:00:00.000Z',
    updated_at: '2026-07-07T00:00:00.000Z',
    metadata: {},
    device_code: 'VENT-014',
    device_type: 'ventilator',
    device_location: 'ICU',
    assignee_name: null,
    ...extra,
  };
}

function schedule() {
  return {
    id: 7,
    tenant_id: TENANT,
    biomed_device_id: 42,
    device_code: 'VENT-014',
    device_type: 'ventilator',
    usage_hours: 1250,
    kind: 'preventive',
    interval_days: null,
    interval_usage_hours: 1000,
    next_due_at: null,
    next_due_usage_hours: 1000,
    assigned_role: 'BIOMEDICAL_STAFF',
    assigned_to_id: null,
    assigned_to_uid: null,
    assigned_vendor: null,
  };
}

function installCommonSqlMock({ existingScheduleWorkOrder = false } = {}) {
  queryRawMock.mockImplementation(async (sql, ...params) => {
    if (sql.includes('LEFT JOIN biomed_maintenance_schedules')) return [];
    if (sql.includes('FROM biomed_maintenance_schedules s') && sql.includes('d.usage_hours')) {
      return [schedule()];
    }
    if (sql.includes('FROM clinical_ai_biomed_devices') && sql.includes('AND id = $2::int')) {
      return [{ id: 42, device_code: 'VENT-014', device_type: 'ventilator', location: 'ICU', usage_hours: 1250 }];
    }
    if (sql.includes('wo.schedule_id = $2::bigint')) {
      return existingScheduleWorkOrder ? [workOrder()] : [];
    }
    if (sql.includes('INSERT INTO biomed_work_orders')) {
      return [{ id: 900 }];
    }
    if (sql.includes('SELECT wo.*') && sql.includes('wo.id = $2::bigint')) {
      return [workOrder({ id: Number(params[1]), status: currentStatus })];
    }
    if (sql.includes('INSERT INTO biomed_work_order_updates')) return [];
    if (sql.includes('role IN (') && sql.includes('BIOMEDICAL_STAFF')) {
      return [{ id: 15, uid: USER_UID, name: 'Biomed Tech', phone: '9000000015', role: 'BIOMEDICAL_STAFF' }];
    }
    if (sql.includes('INSERT INTO biomed_work_order_recipients')) return [];
    if (sql.includes('UPDATE biomed_maintenance_schedules')) return [];
    if (sql.includes('UPDATE clinical_ai_biomed_devices')) return [];
    throw new Error(`Unhandled SQL: ${sql.slice(0, 140)}`);
  });
}

let currentStatus = 'open';

describe('biomedCmmsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentStatus = 'open';
    queueNotificationMock.mockResolvedValue({ id: 1, status: 'PENDING' });
  });

  it('materializes due schedules idempotently by schedule and due window', async () => {
    installCommonSqlMock({ existingScheduleWorkOrder: false });
    const first = await service.materializeDueMaintenanceSchedules({
      tenantId: TENANT,
      now: new Date('2026-07-07T00:00:00.000Z'),
    });
    expect(first.materialized).toBe(1);

    installCommonSqlMock({ existingScheduleWorkOrder: true });
    const second = await service.materializeDueMaintenanceSchedules({
      tenantId: TENANT,
      now: new Date('2026-07-07T00:00:00.000Z'),
    });
    expect(second.work_orders[0].deduped).toBe(true);

    const inserts = queryRawMock.mock.calls.filter(([sql]) => sql.includes('INSERT INTO biomed_work_orders'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toBe(TENANT);
    expect(inserts[0][3]).toBe(7);
  });

  it('walks assigned to in_progress to completed to verified and refreshes device service timestamp', async () => {
    queryRawMock.mockImplementation(async (sql, ...params) => {
      if (sql.includes('SELECT wo.*') && sql.includes('wo.id = $2::bigint')) {
        return [workOrder({ id: Number(params[1]), status: currentStatus })];
      }
      if (sql.includes('UPDATE biomed_work_orders')) {
        currentStatus = params[2];
        return [workOrder({ id: Number(params[1]), status: currentStatus, completed_at: '2026-07-07T01:00:00.000Z' })];
      }
      if (sql.includes('INSERT INTO biomed_work_order_updates')) return [];
      if (sql.includes('UPDATE clinical_ai_biomed_devices')) return [];
      throw new Error(`Unhandled SQL: ${sql.slice(0, 140)}`);
    });

    await service.assignWorkOrder({ tenantId: TENANT, workOrderId: 900, assignedToId: 15, actorUid: USER_UID });
    await service.startWorkOrder({ tenantId: TENANT, workOrderId: 900, actorUid: USER_UID });
    await service.completeWorkOrder({ tenantId: TENANT, workOrderId: 900, actorUid: USER_UID, completionNotes: 'done' });
    const verified = await service.verifyWorkOrder({ tenantId: TENANT, workOrderId: 900, actorUid: USER_UID });

    expect(verified.status).toBe('verified');
    expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('last_preventive_maintenance_at'))).toBe(true);
  });

  it('dedupes device-fault corrective work orders while one remains active', async () => {
    queryRawMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM clinical_ai_biomed_devices') && sql.includes('AND id = $2::int')) {
        return [{ id: 42, device_code: 'VENT-014', device_type: 'ventilator', location: 'ICU' }];
      }
      if (sql.includes("wo.source = 'device_fault'")) return [workOrder({ source: 'device_fault', kind: 'corrective' })];
      throw new Error(`Unhandled SQL: ${sql.slice(0, 140)}`);
    });

    const result = await service.createDeviceFaultWorkOrder({
      tenantId: TENANT,
      biomedDeviceId: 42,
      sourceRef: 'fault-123',
      description: 'HL7 OBX fault cluster',
    });

    expect(result.deduped).toBe(true);
    expect(queryRawMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO biomed_work_orders'))).toBe(false);
  });

  it('requires calibration certificates to use a validated document reference', async () => {
    expect(() => service.rejectRawCertificatePayload({ document_base64: 'abc' })).toThrow(/validated upload/);

    queryRawMock.mockImplementation(async (sql) => {
      if (sql.includes('FROM clinical_ai_biomed_devices') && sql.includes('AND id = $2::int')) {
        return [{ id: 42, device_code: 'VENT-014', device_type: 'ventilator', location: 'ICU' }];
      }
      if (sql.includes('INSERT INTO biomed_calibration_certificates')) {
        return [{
          id: 77,
          tenant_id: TENANT,
          biomed_device_id: 42,
          work_order_id: null,
          certificate_number: 'CAL-2026-001',
          calibrated_at: '2026-07-07T00:00:00.000Z',
          due_at: '2027-07-07T00:00:00.000Z',
          document_id: 'r2://biomed/cert.pdf',
          result: 'pass',
        }];
      }
      if (sql.includes('UPDATE clinical_ai_biomed_devices')) return [];
      throw new Error(`Unhandled SQL: ${sql.slice(0, 140)}`);
    });

    const cert = await service.createCalibrationCertificate({
      tenantId: TENANT,
      biomedDeviceId: 42,
      certificateNumber: 'CAL-2026-001',
      calibratedAt: '2026-07-07T00:00:00.000Z',
      dueAt: '2027-07-07T00:00:00.000Z',
      documentId: 'r2://biomed/cert.pdf',
      result: 'pass',
      rawPayload: { document_id: 'r2://biomed/cert.pdf' },
    });

    expect(cert.document_id).toBe('r2://biomed/cert.pdf');
  });

  it('computes downtime and queues urgent notification outbox rows for SLA breaches', async () => {
    expect(service.calculateDowntimeMinutes(
      '2026-07-07T00:00:00.000Z',
      '2026-07-07T01:30:00.000Z',
    )).toBe(90);

    queryRawMock.mockImplementation(async (sql, ...params) => {
      if (sql.includes('UPDATE biomed_work_orders') && sql.includes("priority = 'urgent'")) {
        return [workOrder({ id: 901, priority: 'urgent', status: 'open', sla_breached_at: params[1] })];
      }
      if (sql.includes('SELECT wo.*') && sql.includes('wo.id = $2::bigint')) {
        return [workOrder({ id: Number(params[1]), priority: 'urgent', sla_breached_at: '2026-07-07T02:00:00.000Z' })];
      }
      if (sql.includes('INSERT INTO biomed_work_order_updates')) return [];
      if (sql.includes('role IN (') && sql.includes('BIOMEDICAL_STAFF')) {
        return [{ id: 15, uid: USER_UID, name: 'Biomed Tech', phone: '9000000015', role: 'BIOMEDICAL_STAFF' }];
      }
      if (sql.includes('INSERT INTO biomed_work_order_recipients')) return [];
      throw new Error(`Unhandled SQL: ${sql.slice(0, 140)}`);
    });

    const result = await service.escalateBreachedWorkOrders({
      tenantId: TENANT,
      now: new Date('2026-07-07T02:00:00.000Z'),
    });

    expect(result.escalated_count).toBe(1);
    expect(queueNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Urgent biomedical SLA breach',
      data: expect.objectContaining({ priority: 'urgent' }),
    }));
  });

  it('uses tenant-scoped transactions for writes', async () => {
    installCommonSqlMock({ existingScheduleWorkOrder: false });
    await service.createWorkOrder({
      tenantId: TENANT,
      biomedDeviceId: 42,
      kind: 'corrective',
      priority: 'high',
      description: 'Replace pump roller',
      source: 'manual',
    });

    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    const insert = queryRawMock.mock.calls.find(([sql]) => sql.includes('INSERT INTO biomed_work_orders'));
    expect(insert[1]).toBe(TENANT);
  });
});
