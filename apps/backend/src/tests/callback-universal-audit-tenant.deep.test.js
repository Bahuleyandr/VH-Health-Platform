import express from 'express';
import request from 'supertest';

import prisma from '../lib/prisma.js';
import { auditLogMiddleware } from '../middleware/auditLog.js';
import { getAuditEventDetail } from '../services/compliance/auditAccountabilityService.js';
import {
  setAuthenticatedCallbackAuditContext,
} from '../utils/authenticatedCallbackAudit.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '87800000-0000-4000-8000-000000000002';
const MARKER = 'pr878-callback-audit';

const CALLBACKS = [
  {
    name: 'payment',
    path: '/webhooks/payments/pr878-payment-bearer',
    route: '/webhooks/payments/:credential',
    provider: 'razorpay',
    actor: 'razorpay',
    storedPath: '/webhooks/payments/[REDACTED]',
  },
  {
    name: 'uhi',
    path: '/api/v1/uhi/search',
    route: '/api/v1/uhi/search',
    provider: 'uhi',
    actor: 'eua.pr878.example',
    storedPath: '/api/v1/uhi/search',
  },
  {
    name: 'sms',
    path: '/webhooks/sms/dlr/pr878-sms-bearer',
    route: '/webhooks/sms/dlr/:credential',
    provider: 'msg91',
    actor: 'msg91',
    storedPath: '/webhooks/sms/dlr/[REDACTED]',
  },
];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = req.get('x-request-id');
    next();
  });
  app.use(auditLogMiddleware);
  for (const callback of CALLBACKS) {
    app.post(callback.route, (req, res) => {
      if (req.get('x-provider-authenticated') === 'yes') {
        setAuthenticatedCallbackAuditContext(req, {
          tenantId: TENANT_A,
          provider: callback.provider,
          externalActorId: callback.actor,
        });
      }
      const status = Number(req.get('x-response-status') || 200);
      res.status(status).json({ success: status < 400 });
    });
  }
  return app;
}

async function clean() {
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM audit_log WHERE metadata->>'request_id' LIKE $1`,
    `${MARKER}%`,
  ).catch(() => {});
}

async function waitForRows(expected) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text, user_name, user_role, path, request_summary,
              query_params, status_code, success, metadata
         FROM audit_log
        WHERE metadata->>'request_id' LIKE $1
        ORDER BY id`,
      `${MARKER}%`,
    );
    if (rows.length === expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} callback audit rows`);
}

d('authenticated callback universal-audit tenant attribution', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'pr878-audit-other-tenant', 'PR878 Audit Other Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );
    await clean();
  });

  afterAll(async () => {
    await clean();
  });

  it('attributes payment, UHI, and SMS successes and post-auth failures only to the resolved tenant', async () => {
    const app = buildApp();
    let requestNumber = 0;
    for (const callback of CALLBACKS) {
      for (const status of [202, 503]) {
        requestNumber += 1;
        await request(app)
          .post(`${callback.path}?phone=%2B919876543210`)
          .set('x-request-id', `${MARKER}-${requestNumber}`)
          .set('x-provider-authenticated', 'yes')
          .set('x-response-status', String(status))
          .send({
            tenant_id: TENANT_B,
            patient_name: 'Tenant A Callback Patient',
            phone: '+919876543210',
          })
          .expect(status);
      }
    }

    const rows = await waitForRows(6);
    expect(rows).toHaveLength(6);
    for (const callback of CALLBACKS) {
      const callbackRows = rows.filter((row) => row.path === callback.storedPath);
      expect(callbackRows).toHaveLength(2);
      expect(callbackRows.map((row) => row.status_code).sort()).toEqual([202, 503]);
      for (const row of callbackRows) {
        expect(row.tenant_id).toBe(TENANT_A);
        expect(row.user_name).toBe(`${callback.provider} callback`);
        expect(row.user_role).toBe('SYSTEM');
        expect(row.request_summary).toBeNull();
        expect(row.query_params).toBeNull();
        expect(row.metadata).toEqual(expect.objectContaining({
          tenant_id: TENANT_A,
          actor_type: 'external_provider',
          callback_provider: callback.provider,
          external_actor_id: callback.actor,
          authenticated_callback: true,
        }));

        await expect(getAuditEventDetail(TENANT_A, 'request', String(row.id)))
          .resolves.toEqual(expect.objectContaining({
            event: expect.objectContaining({ id: String(row.id) }),
          }));
        await expect(getAuditEventDetail(TENANT_B, 'request', String(row.id)))
          .rejects.toMatchObject({ code: 'AUDIT_EVENT_NOT_FOUND' });
      }
    }
    expect(JSON.stringify(rows)).not.toContain('Tenant A Callback Patient');
    expect(JSON.stringify(rows)).not.toContain('9876543210');
    expect(JSON.stringify(rows)).not.toContain('pr878-payment-bearer');
    expect(JSON.stringify(rows)).not.toContain('pr878-sms-bearer');
  });

  it('does not persist failed-before-authentication callback bodies under any tenant', async () => {
    const app = buildApp();
    for (const [index, callback] of CALLBACKS.entries()) {
      await request(app)
        .post(callback.path)
        .set('x-request-id', `${MARKER}-unauth-${index}`)
        .set('x-response-status', '401')
        .send({ patient_name: 'Untrusted Callback Patient', phone: '+919876543210' })
        .expect(401);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM audit_log WHERE metadata->>'request_id' LIKE $1`,
      `${MARKER}-unauth-%`,
    );
    expect(rows).toHaveLength(0);
  });
});
