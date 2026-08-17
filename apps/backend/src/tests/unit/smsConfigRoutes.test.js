// src/tests/unit/smsConfigRoutes.test.js
//
// The admin /api/v1/admin/notifications/sms surface (mounted behind the
// admin role/step-up stack in app.js — this suite covers the router's own
// contract): validation, write-only secret handling (the service is handed
// the plaintext exactly once; the route never echoes it beyond the service
// view), and the one-time callback-token passthrough.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const listSmsProviderConfigs = jest.fn();
const upsertSmsProviderConfig = jest.fn();
const listSmsTemplateRegistrations = jest.fn();
const createSmsTemplateRegistration = jest.fn();
const updateSmsTemplateRegistration = jest.fn();
const logAuditMock = jest.fn(async () => {});

jest.unstable_mockModule('../../services/notification/smsProviderConfigService.js', () => ({
  listSmsProviderConfigs,
  upsertSmsProviderConfig,
  listSmsTemplateRegistrations,
  createSmsTemplateRegistration,
  updateSmsTemplateRegistration,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => 'trusted-tenant',
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { default: router } = await import('../../routes/admin/smsConfigRoutes.js');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
    next();
  });
  instance.use('/api/v1/admin/notifications/sms', router);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('provider config surface', () => {
  it('GET /config returns the service view for the resolved tenant', async () => {
    listSmsProviderConfigs.mockResolvedValue({
      env_provider: null, env_kill_switch: false, tenant_enabled: false, configs: [],
    });
    const res = await request(app()).get('/api/v1/admin/notifications/sms/config');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tenant_enabled: false, configs: [] });
    expect(listSmsProviderConfigs).toHaveBeenCalledWith('trusted-tenant');
  });

  it('PUT /config rejects an unknown provider at the validator', async () => {
    const res = await request(app())
      .put('/api/v1/admin/notifications/sms/config')
      .send({ provider: 'smsc-classic' });
    expect(res.status).toBe(400);
    expect(upsertSmsProviderConfig).not.toHaveBeenCalled();
  });

  it('PUT /config rejects an omitted enabled flag (omission must not silently disable a live config)', async () => {
    const res = await request(app())
      .put('/api/v1/admin/notifications/sms/config')
      .send({ provider: 'msg91', auth_key: 'rotated-authkey' });
    expect(res.status).toBe(400);
    expect(upsertSmsProviderConfig).not.toHaveBeenCalled();
  });

  it('never echoes a rejected write-only auth_key value in validator errors', async () => {
    const credential = `credential-${'s'.repeat(220)}`;
    const res = await request(app())
      .put('/api/v1/admin/notifications/sms/config')
      .send({ provider: 'msg91', enabled: true, auth_key: credential });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(credential);
    expect(res.body.errors).toEqual(expect.arrayContaining([
      expect.not.objectContaining({ value: expect.anything() }),
    ]));
    expect(upsertSmsProviderConfig).not.toHaveBeenCalled();
  });

  it('PUT /config forwards the write-only secret and passes the one-time token through', async () => {
    upsertSmsProviderConfig.mockResolvedValue({
      id: 7, provider: 'msg91', enabled: true, sender_id: 'VHHLTH',
      dlt_entity_id: '1101', has_auth_key: true, has_callback_token: true,
      callback_token: 'one-time-token', dlr_path: '/webhooks/sms/dlr/one-time-token',
    });
    const res = await request(app())
      .put('/api/v1/admin/notifications/sms/config')
      .send({
        provider: 'msg91', enabled: true, sender_id: 'VHHLTH',
        dlt_entity_id: '1101', auth_key: 'super-secret-authkey',
      });
    expect(res.status).toBe(200);
    expect(upsertSmsProviderConfig).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant',
      provider: 'msg91',
      enabled: true,
      auth_key: 'super-secret-authkey',
      created_by: '11111111-1111-4111-8111-111111111111',
    }));
    expect(res.body.data).toMatchObject({
      callback_token: 'one-time-token',
      dlr_path: '/webhooks/sms/dlr/one-time-token',
      has_auth_key: true,
    });
    // The audit row records presence booleans, never the material.
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      'SMS_GATEWAY_CONFIG_UPSERTED',
      expect.objectContaining({ auth_key_present: true, callback_token_minted: true }),
      expect.objectContaining({ resource: 'sms_provider_config', resourceId: 7 }),
    );
    const auditMeta = logAuditMock.mock.calls[0][2];
    expect(JSON.stringify(auditMeta)).not.toContain('super-secret-authkey');
    expect(JSON.stringify(auditMeta)).not.toContain('one-time-token');
  });

  it('relays a service AppError (e.g. one-enabled-config conflict) with its status', async () => {
    const { AppError } = await import('../../utils/AppError.js');
    upsertSmsProviderConfig.mockRejectedValue(
      AppError.conflict('Another SMS provider config is already enabled', 'SMS_CONFIG_CONFLICT'),
    );
    const res = await request(app())
      .put('/api/v1/admin/notifications/sms/config')
      .send({ provider: 'twilio', enabled: true });
    expect(res.status).toBe(409);
  });
});

describe('template registration surface', () => {
  it('GET /templates lists registrations', async () => {
    listSmsTemplateRegistrations.mockResolvedValue([
      { id: 31, template_key: 'sms.billing_payment_link.v1', dlt_template_id: '110710', active: true },
    ]);
    const res = await request(app()).get('/api/v1/admin/notifications/sms/templates');
    expect(res.status).toBe(200);
    expect(res.body.data.templates).toHaveLength(1);
  });

  it('POST /templates requires template_key and dlt_template_id', async () => {
    const res = await request(app())
      .post('/api/v1/admin/notifications/sms/templates')
      .send({ template_key: 'sms.billing_payment_link.v1' });
    expect(res.status).toBe(400);
    expect(createSmsTemplateRegistration).not.toHaveBeenCalled();
  });

  it('POST /templates creates a registration and audits it', async () => {
    createSmsTemplateRegistration.mockResolvedValue({
      id: 32, provider_config_id: 7, template_key: 'sms.billing_payment_link.v1',
      dlt_template_id: '1107100000000012345', active: true,
    });
    const res = await request(app())
      .post('/api/v1/admin/notifications/sms/templates')
      .send({
        template_key: 'sms.billing_payment_link.v1',
        dlt_template_id: '1107100000000012345',
      });
    expect(res.status).toBe(200);
    expect(createSmsTemplateRegistration).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant',
      template_key: 'sms.billing_payment_link.v1',
      dlt_template_id: '1107100000000012345',
      active: true,
    }));
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(), 'SMS_TEMPLATE_REGISTERED', expect.anything(), expect.anything(),
    );
  });

  it('PUT /templates/:id updates a registration (deactivation fail-closes sends)', async () => {
    updateSmsTemplateRegistration.mockResolvedValue({
      id: 32, template_key: 'sms.billing_payment_link.v1', active: false,
    });
    const res = await request(app())
      .put('/api/v1/admin/notifications/sms/templates/32')
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(updateSmsTemplateRegistration).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'trusted-tenant', id: '32', active: false,
    }));
  });

  it('PUT /templates/:id rejects a non-numeric id at the validator', async () => {
    const res = await request(app())
      .put('/api/v1/admin/notifications/sms/templates/not-a-number')
      .send({ active: false });
    expect(res.status).toBe(400);
    expect(updateSmsTemplateRegistration).not.toHaveBeenCalled();
  });
});
