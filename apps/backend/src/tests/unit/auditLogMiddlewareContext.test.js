import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();
const errorMock = jest.fn();

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
    error: errorMock,
  },
}));

const {
  auditLogMiddleware,
  waitForAuditLogDrain,
  deriveAction,
  deriveModule,
  deriveAuditResourceContext,
  sanitizeBody,
  sanitizeQueryParameters,
} = await import(
  '../../middleware/auditLog.js'
);
const { setAuthenticatedCallbackAuditContext } = await import(
  '../../utils/authenticatedCallbackAudit.js'
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
  errorMock.mockReset();
});

afterEach(async () => {
  await waitForAuditLogDrain();
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
    // `reason` and `xml` carry clinical free text on the import surface...
    const reconciliationBody = {
      reason: 'patient-specific correction narrative',
      envelope: { xml: '<ClinicalDocument>private</ClinicalDocument>' },
    };
    const reconciliationSummary = sanitizeBody(
      reconciliationBody,
      '/api/v1/documents/import/reconciliation/abc/resolve',
    );
    expect(reconciliationSummary).not.toContain('patient-specific correction narrative');
    expect(reconciliationSummary).not.toContain('ClinicalDocument');
    expect(reconciliationSummary.match(/REDACTED_CLINICAL_TEXT/g)).toHaveLength(2);

    // ...but `reason` is the operational justification everywhere else, and an
    // auditor reading a break-glass record needs to see it. Redacting it
    // platform-wide would erase the one field that says whether the emergency
    // access was warranted.
    const breakGlassSummary = sanitizeBody(
      { reason: 'cardiac arrest, attending unreachable' },
      '/api/v1/emr/break-glass',
    );
    expect(breakGlassSummary).toContain('cardiac arrest, attending unreachable');
    expect(breakGlassSummary).not.toContain('REDACTED_CLINICAL_TEXT');
    // A body with no path context keeps the conservative platform-wide set.
    expect(sanitizeBody({ notes: 'sensitive' })).toContain('REDACTED_CLINICAL_TEXT');
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

  it('redacts concrete credential aliases without hiding ordinary workflow fields', () => {
    const serialized = sanitizeBody({
      auth_header: 'Bearer snake-secret',
      authHeader: 'Bearer camel-secret',
      'refresh-token': 'dash-secret',
      currentPassword: 'current-secret',
      new_password: 'new-secret',
      nested: {
        sender_bearer_token: 'device-secret',
        encryptedSecret: 'mfa-secret',
        aadhaarNumber: '1234 5678 9012',
        bankAccount: '0000111122223333',
        clinicalNotes: 'private clinical narrative',
      },
      token_number: 'OP-17',
      code: 'SNOMED-44054006',
      endpoint_url: 'https://receiver.example/hl7?api_key=url-secret&tenant=one',
    });

    for (const secret of [
      'snake-secret',
      'camel-secret',
      'dash-secret',
      'current-secret',
      'new-secret',
      'device-secret',
      'mfa-secret',
      '1234 5678 9012',
      '0000111122223333',
      'private clinical narrative',
      'url-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('OP-17');
    expect(serialized).toContain('SNOMED-44054006');
    expect(serialized).toContain('https://receiver.example/hl7?api_key=[REDACTED]&tenant=one');
  });

  it('keeps stored query parameters valid JSON after redacting a long query', () => {
    const serialized = sanitizeQueryParameters({
      authHeader: 'Bearer long-query-secret',
      filter: 'x'.repeat(700),
      token_number: 'OP-17',
    });

    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain('long-query-secret');
    expect(JSON.parse(serialized)).toEqual({
      authHeader: '[REDACTED]',
      filter: 'x'.repeat(700),
      token_number: 'OP-17',
    });
  });

  it.each([201, 400, 403])(
    'never persists HL7 feed credentials on a %i response',
    async (statusCode) => {
      const bodySecret = `Bearer audit-body-secret-${statusCode}`;
      const nestedSecret = `nested-refresh-secret-${statusCode}`;
      const querySecret = `query-auth-secret-${statusCode}`;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.id = `req-hl7-audit-${statusCode}`;
        req.tenantId = TENANT_ID;
        req.user = { uid: ACTOR_UID, role: 'INTEGRATION_ADMIN' };
        next();
      });
      app.use(auditLogMiddleware);
      app.post('/api/v1/hl7-feeds/subscriptions', (_req, res) => {
        res.status(statusCode).json({ success: statusCode < 400 });
      });

      await request(app)
        .post('/api/v1/hl7-feeds/subscriptions')
        .query({ authHeader: querySecret, token_number: 'OP-17' })
        .send({
          name: 'Audit proof receiver',
          endpoint_url: 'https://receiver.example/hl7',
          auth_header: bodySecret,
          nested: { refreshToken: nestedSecret },
          token_number: 'OP-17',
        })
        .expect(statusCode);
      await waitForAuditWrite();

      const call = queryRawUnsafeMock.mock.calls[0];
      expect(call[13]).toContain('[REDACTED]');
      expect(call[13]).toContain('OP-17');
      expect(call[14]).toContain('[REDACTED]');
      expect(call[14]).toContain('Audit proof receiver');
      expect(call[23]).toBe(TENANT_ID);
      expect(JSON.stringify(call)).not.toContain(bodySecret);
      expect(JSON.stringify(call)).not.toContain(nestedSecret);
      expect(JSON.stringify(call)).not.toContain(querySecret);
    },
  );

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
    expect(call[23]).toBe(TENANT_ID);
    expect(call[0]).toContain('device_type, tenant_id');
  });

  it('stores SMS callback paths without their bearer token', async () => {
    const token = 'tok_abcdefghijklmnopqrstuvwxyz01';
    const phone = '+919876543210';
    const app = express();
    app.use(express.json());
    app.use(auditLogMiddleware);
    app.post('/webhooks/sms/dlr/:token', (req, res) => {
      setAuthenticatedCallbackAuditContext(req, {
        tenantId: TENANT_ID,
        provider: 'msg91',
        externalActorId: 'msg91',
      });
      res.status(200).json({ ok: true });
    });

    await request(app)
      .post(`/webhooks/sms/dlr/${token}?To=${encodeURIComponent(phone)}`)
      .send({ status: 'delivered', mobile: phone })
      .expect(200);
    await waitForAuditWrite();

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[7]).toBe('/webhooks/sms/dlr/[REDACTED]');
    expect(call[13]).toBeNull();
    expect(call[14]).toBeNull();
    expect(call[23]).toBe(TENANT_ID);
    expect(JSON.stringify(call)).not.toContain(token);
    expect(JSON.stringify(call)).not.toContain('9876543210');
  });

  it.each([
    ['/webhooks/payments/payment-bearer-audit-token?phone=%2B919876543210', '/webhooks/payments/[REDACTED]', 'razorpay'],
    ['/api/v1/uhi/search?patient=tenant-a-patient', '/api/v1/uhi/search', 'uhi'],
    ['/webhooks/sms/twilio-status/sms-bearer-audit-token?To=%2B919876543210', '/webhooks/sms/twilio-status/[REDACTED]', 'twilio'],
  ])('writes authenticated %s callbacks to the resolved tenant with provider identity and no request PHI', async (
    callbackUrl,
    expectedPath,
    provider,
  ) => {
    const app = express();
    app.use(express.json());
    app.use(auditLogMiddleware);
    app.post(expectedPath.replace('/[REDACTED]', '/:token'), (req, res) => {
      setAuthenticatedCallbackAuditContext(req, {
        tenantId: TENANT_ID,
        provider,
        externalActorId: `${provider}.system`,
      });
      res.status(503).json({ success: false });
    });

    await request(app)
      .post(callbackUrl)
      .send({
        tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        patient_name: 'Tenant A Patient',
        phone: '+919876543210',
      })
      .expect(503);
    await waitForAuditWrite();

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).toContain('device_type, tenant_id');
    expect(call[3]).toBe(`${provider} callback`);
    expect(call[4]).toBe('SYSTEM');
    expect(call[7]).toBe(expectedPath);
    expect(call[13]).toBeNull();
    expect(call[14]).toBeNull();
    expect(call[15]).toBe(503);
    expect(call[19]).toBeNull();
    expect(call[20]).toBeNull();
    expect(call[23]).toBe(TENANT_ID);
    expect(JSON.parse(call[12])).toEqual(expect.objectContaining({
      tenant_id: TENANT_ID,
      actor_role: 'SYSTEM',
      actor_type: 'external_provider',
      callback_provider: provider,
      external_actor_id: `${provider}.system`,
      authenticated_callback: true,
    }));
    expect(JSON.stringify(call)).not.toContain('Tenant A Patient');
    expect(JSON.stringify(call)).not.toContain('9876543210');
    expect(JSON.stringify(call)).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('preserves tenant and provider identity without PHI in the callback DB-failure fallback', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('audit database unavailable'));
    const app = express();
    app.use(express.json());
    app.use(auditLogMiddleware);
    app.post('/webhooks/payments/:token', (req, res) => {
      setAuthenticatedCallbackAuditContext(req, {
        tenantId: TENANT_ID,
        provider: 'razorpay',
        externalActorId: 'razorpay',
      });
      res.status(503).json({ success: false });
    });

    await request(app)
      .post('/webhooks/payments/fallback-payment-bearer?phone=%2B919876543210')
      .send({ patient_name: 'Tenant A Patient', phone: '+919876543210' })
      .expect(503);
    await waitForAuditWrite();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errorMock).toHaveBeenCalledWith(
      'Audit log DB write failed, writing to file fallback:',
      expect.objectContaining({
        userId: null,
        userRole: 'SYSTEM',
        path: '/webhooks/payments/[REDACTED]',
        tenant_id: TENANT_ID,
        callback_provider: 'razorpay',
        external_actor_id: 'razorpay',
        verification_state: 'verified',
      }),
    );
    expect(JSON.stringify(errorMock.mock.calls)).not.toContain('Tenant A Patient');
    expect(JSON.stringify(errorMock.mock.calls)).not.toContain('9876543210');
    expect(JSON.stringify(errorMock.mock.calls)).not.toContain('fallback-payment-bearer');
  });

  it.each([
    '/webhooks/payments',
    '/webhooks/payments/untrusted-payment-token',
    '/api/v1/uhi/search',
    '/webhooks/sms',
    '/webhooks/sms/dlr/untrusted-sms-token',
  ])('does not create a universal PHI audit row for an unauthenticated callback at %s', async (path) => {
    const app = express();
    app.use(express.json());
    app.use(auditLogMiddleware);
    app.post(path, (_req, res) => res.status(401).json({ success: false }));

    await request(app)
      .post(path)
      .send({ patient_name: 'Untrusted Patient', phone: '+919876543210' })
      .expect(401);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledWith(
      'Audit log unattributed provider callback, writing to file fallback:',
      expect.objectContaining({
        action: 'provider_callback_rejected',
        path: expect.not.stringContaining('untrusted-'),
        verification_state: 'unverified',
        tenant_id: null,
      }),
    );
    expect(JSON.stringify(errorMock.mock.calls)).not.toContain('Untrusted Patient');
    expect(JSON.stringify(errorMock.mock.calls)).not.toContain('9876543210');
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
