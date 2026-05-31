import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
  },
}));

const { auditLogMiddleware, deriveAuditResourceContext } = await import(
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
      appointment_id: '123',
      admission_id: '55',
      patient_uid: PATIENT_UID,
    }));
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
    expect(call[9]).toBe('update');
    expect(call[10]).toBe('appointment');
    expect(call[11]).toBe('123');

    const metadata = JSON.parse(call[12]);
    expect(metadata).toEqual(expect.objectContaining({
      request_id: 'req-front-office-audit',
      tenant_id: TENANT_ID,
      actor_role: 'RECEPTIONIST',
      device_type: 'desktop',
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
});
