import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
  },
}));

const { auditLogMiddleware, deriveAction, deriveModule, deriveAuditResourceContext, sanitizeBody } = await import(
  '../../middleware/auditLog.js'
);

const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

async function waitForAuditWrite() {
  for (let i = 0; i < 10; i += 1) {
    if (queryRawUnsafeMock.mock.calls.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for audit write');
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset().mockResolvedValue({});
  warnMock.mockReset();
});

describe('auditLogMiddleware context enrichment', () => {
  it('derives patient, appointment, admission, device, tenant, and request context', () => {
    const result = deriveAuditResourceContext(
      {
        id: 'req-front-office-ctx',
        tenantId: TENANT_ID,
        params: {},
        query: {},
        headers: { 'x-device-type': 'desktop' },
        body: {
          patient_uid: PATIENT_UID,
          admission_id: 55,
        },
      },
      '/api/v1/appointments/123/status',
      {
        deviceType: 'desktop',
        userRole: 'RECEPTIONIST',
      },
    );

    expect(result.resource).toBe('appointment');
    expect(result.resourceId).toBe('123');
    expect(result.metadata).toEqual(expect.objectContaining({
      request_id: 'req-front-office-ctx',
      tenant_id: TENANT_ID,
      actor_role: 'RECEPTIONIST',
      device_type: 'desktop',
      request_device_type: 'desktop',
      appointment_id: '123',
      admission_id: '55',
      patient_uid: PATIENT_UID,
    }));
  });

  it('classifies staff clinical routes before the generic staff-user rules', () => {
    expect(deriveAction('POST', '/api/v1/staff/medical/consultations'))
      .toBe('create_clinical_note');
    expect(deriveModule('/api/v1/staff/medical/consultations'))
      .toBe('clinical_notes');
    expect(deriveAction('POST', '/api/v1/staff/medical/investigations'))
      .toBe('record_investigation_result');
    expect(deriveModule('/api/v1/staff/medical/investigations'))
      .toBe('investigations');
  });

  it('names audit oversight actions and redacts clinical free text', () => {
    expect(deriveAction('GET', '/api/v1/admin/audit/events')).toBe('view_audit_events');
    expect(deriveAction('GET', '/api/v1/admin/audit/export')).toBe('export_audit_events');
    expect(sanitizeBody({ patient_uid: 'patient', notes: 'sensitive', result: { value: 'secret' } }))
      .toContain('REDACTED_CLINICAL_TEXT');
    expect(sanitizeBody({ notes: 'sensitive' })).not.toContain('sensitive');
    const gatewaySecrets = sanitizeBody({
      auth_key: 'sms-auth-secret',
      key_secret: 'payment-key-secret',
      webhook_secret: 'payment-webhook-secret',
      callback_token: 'callback-bearer-secret',
    });
    expect(gatewaySecrets).not.toContain('sms-auth-secret');
    expect(gatewaySecrets).not.toContain('payment-key-secret');
    expect(gatewaySecrets).not.toContain('payment-webhook-secret');
    expect(gatewaySecrets).not.toContain('callback-bearer-secret');
  });

  it('writes universal audit_log rows with searchable resource metadata', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.id = 'req-front-office-audit';
      req.tenantId = TENANT_ID;
      req.user = {
        id: 77,
        uid: ACTOR_UID,
        name: 'Front Office User',
        role: 'RECEPTIONIST',
        deviceType: 'desktop',
      };
      next();
    });
    app.use(auditLogMiddleware);
    app.put('/api/v1/appointments/:id/status', (_req, res) => {
      res.status(200).json({ success: true });
    });

    await request(app)
      .put('/api/v1/appointments/123/status?source=workbench')
      .set('User-Agent', 'VH Staff Windows')
      .set('X-Forwarded-For', '10.0.0.10')
      .set('X-Device-Type', 'tablet')
      .send({
        status: 'IN_PROGRESS',
        patient_uid: PATIENT_UID,
        admission_id: 55,
      })
      .expect(200);

    await waitForAuditWrite();

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).toContain('resource, resource_id, metadata');
    expect(call[1]).toBe(ACTOR_UID);
    expect(call[2]).toBe(77);
    expect(call[4]).toBe('RECEPTIONIST');
    expect(call[9]).toBe('update_appointment_status');
    expect(call[10]).toBe('appointment');
    expect(call[11]).toBe('123');

    const metadata = JSON.parse(call[12]);
    expect(metadata).toEqual(expect.objectContaining({
      request_id: 'req-front-office-audit',
      tenant_id: TENANT_ID,
      actor_role: 'RECEPTIONIST',
      device_type: 'desktop',
      request_device_type: 'tablet',
      device_type_mismatch: true,
      appointment_id: '123',
      admission_id: '55',
      patient_uid: PATIENT_UID,
    }));
    expect(JSON.parse(call[13])).toEqual({ source: 'workbench' });
    expect(call[19]).toBe(ACTOR_UID);
    expect(call[20]).toBe(ACTOR_UID);
    expect(call[21]).toBe(false);
    expect(call[22]).toBe('desktop');
  });

  it('stores SMS callback paths without their bearer token', async () => {
    const token = 'tok_abcdefghijklmnopqrstuvwxyz01';
    const phone = '+919876543210';
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.user = { uid: ACTOR_UID, role: 'SYSTEM' };
      next();
    });
    app.use(auditLogMiddleware);
    app.post('/webhooks/sms/dlr/:token', (_req, res) => res.status(200).json({ ok: true }));

    await request(app)
      .post(`/webhooks/sms/dlr/${token}?To=${encodeURIComponent(phone)}`)
      .send({ status: 'delivered', mobile: phone })
      .expect(200);
    await waitForAuditWrite();

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[7]).toBe('/webhooks/sms/dlr/[REDACTED]');
    expect(call[13]).toBeNull();
    expect(call[14]).toBeNull();
    expect(JSON.stringify(call)).not.toContain(token);
    expect(JSON.stringify(call)).not.toContain('9876543210');
  });

  it('uses workflow-specific audit action names for staff operations', () => {
    expect(deriveAction('POST', '/api/v1/appointments/123/confirm'))
      .toBe('confirm_appointment');
    expect(deriveAction('POST', '/api/v1/appointments/123/no-show'))
      .toBe('mark_appointment_no_show');
    expect(deriveAction('POST', '/api/v1/appointments/123/reschedule'))
      .toBe('reschedule_appointment');
    expect(deriveAction('POST', '/api/v1/appointments/walk-in'))
      .toBe('register_walk_in');
    expect(deriveAction('POST', '/api/v1/emr/admissions/55/assign-bed'))
      .toBe('assign_admission_bed');
    expect(deriveAction('POST', '/api/v1/emr/admissions/55/mark-for-discharge'))
      .toBe('mark_for_discharge');
    expect(deriveAction('POST', '/api/v1/emr/admissions/55/consults/pharmacy/complete'))
      .toBe('complete_discharge_work_item');
    expect(deriveAction('POST', '/api/v1/emr/admissions/55/discharge'))
      .toBe('final_discharge');
    expect(deriveAction('POST', '/api/v1/emr/vitals')).toBe('record_vitals');
    expect(deriveAction('PATCH', '/api/v1/emr/vitals/10')).toBe('correct_vitals');
    expect(deriveAction('POST', '/api/v1/emr/io')).toBe('record_io');
    expect(deriveAction('POST', '/api/v1/beds/20/ready')).toBe('mark_bed_ready');
    expect(deriveAction('POST', '/api/v1/notifications/7/acknowledge'))
      .toBe('acknowledge_alert');
  });

  it('uses clinical audit action and module names for IP command board workflows', () => {
    expect(deriveAction('POST', '/api/v1/emr/notes')).toBe('create_clinical_note');
    expect(deriveAction('PUT', '/api/v1/emr/notes/10')).toBe('update_clinical_note');
    expect(deriveAction('POST', '/api/v1/emr/notes/10/sign')).toBe('sign_clinical_note');
    expect(deriveAction('POST', '/api/v1/emr/orders')).toBe('create_clinical_order');
    expect(deriveAction('PUT', '/api/v1/emr/orders/9/verify')).toBe('verify_clinical_order');
    expect(deriveAction('PUT', '/api/v1/emr/orders/9/complete')).toBe('complete_clinical_order');
    expect(deriveAction('PUT', '/api/v1/emr/orders/9/discontinue')).toBe('discontinue_clinical_order');
    expect(deriveAction('GET', '/api/v1/emr/timeline/patient-1')).toBe('view_patient_timeline');
    expect(deriveAction('GET', '/api/v1/emr/case-sheet/55')).toBe('view_case_sheet');
    expect(deriveAction('GET', '/api/v1/clinical/drug-chart/admission/55')).toBe('view_drug_chart');
    expect(deriveAction('PATCH', '/api/v1/clinical/drug-chart/55/administer')).toBe('update_drug_chart');
    expect(deriveAction('POST', '/api/v1/discharge-summaries/55/sign')).toBe('sign_discharge_summary');
    expect(deriveAction('POST', '/api/v1/lab/alerts/critical/55/ack')).toBe('acknowledge_critical_lab_alert');

    expect(deriveModule('/api/v1/emr/notes/patient/patient-1')).toBe('clinical_notes');
    expect(deriveModule('/api/v1/emr/orders/patient/patient-1')).toBe('clinical_orders');
    expect(deriveModule('/api/v1/clinical/drug-chart/admission/55')).toBe('drug_chart');
    expect(deriveModule('/api/v1/emr/case-sheet/55')).toBe('case_sheet');
    expect(deriveModule('/api/v1/discharge-summaries/55')).toBe('discharge_summaries');
    expect(deriveModule('/API/V1/LAB/ALERTS/CRITICAL/55')).toBe('critical_lab_alerts');
  });
});
