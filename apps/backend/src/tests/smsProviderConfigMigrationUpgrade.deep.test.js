// Retained-database proof for the published SMS migration 699 followed by
// additive credential/callback convergence in migration 711.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const published699 = readFileSync(
  new URL('../migrations/699_sms_provider_configs.sql', import.meta.url), 'utf8',
);
const upgrade711 = readFileSync(
  new URL('../migrations/711_sms_twilio_enabled_config_guard.sql', import.meta.url), 'utf8',
);

d('SMS provider retained migration 699 to 711', () => {
  let client;
  let schema;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    schema = `sms_provider_upgrade_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE tenants (id UUID PRIMARY KEY);
      CREATE FUNCTION app_current_tenant_id_uuid() RETURNS UUID
      LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);
    await client.query(published699);
  });

  afterEach(async () => {
    await client.query('RESET search_path').catch(() => {});
    if (schema) await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    schema = null;
  });

  afterAll(async () => {
    await client?.end().catch(() => {});
  });

  it('preserves published 699 and fails closed until every enabled provider guard is satisfied', async () => {
    expect(published699).not.toContain('callback_token_ciphertext');
    const msg91Tenant = randomUUID();
    const twilioTenant = randomUUID();
    await client.query('INSERT INTO tenants (id) VALUES ($1), ($2)', [msg91Tenant, twilioTenant]);
    await client.query(
      `INSERT INTO sms_provider_configs
         (tenant_id, provider, enabled, sender_id, dlt_entity_id,
          auth_key_ciphertext, account_sid)
       VALUES ($1, 'msg91', TRUE, 'VHHLTH', 'entity-1', 'enc:msg91', NULL),
              ($2, 'twilio', TRUE, 'VHHLTH', 'entity-2', 'enc:twilio', NULL)`,
      [msg91Tenant, twilioTenant],
    );

    await client.query(upgrade711);

    const retained = await client.query(
      `SELECT tenant_id, enabled, callback_token_ciphertext,
              metadata->>'disabled_reason' AS disabled_reason
         FROM sms_provider_configs
        ORDER BY tenant_id`,
    );
    expect(retained.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tenant_id: msg91Tenant,
        enabled: false,
        callback_token_ciphertext: null,
        disabled_reason: 'incomplete_enabled_sms_provider_config',
      }),
      expect.objectContaining({
        tenant_id: twilioTenant,
        enabled: false,
        callback_token_ciphertext: null,
        disabled_reason: 'incomplete_enabled_sms_provider_config',
      }),
    ]));

    await expect(client.query(
      'UPDATE sms_provider_configs SET enabled = TRUE WHERE tenant_id = $1',
      [msg91Tenant],
    )).rejects.toMatchObject({ code: '23514' });

    await client.query(
      `UPDATE sms_provider_configs
          SET callback_token_hash = $2,
              callback_token_ciphertext = 'enc:callback-msg91',
              enabled = TRUE
        WHERE tenant_id = $1`,
      [msg91Tenant, 'a'.repeat(64)],
    );

    await client.query(
      `UPDATE sms_provider_configs
          SET callback_token_hash = $2,
              callback_token_ciphertext = 'enc:callback-twilio'
        WHERE tenant_id = $1`,
      [twilioTenant, 'b'.repeat(64)],
    );
    await expect(client.query(
      'UPDATE sms_provider_configs SET enabled = TRUE WHERE tenant_id = $1',
      [twilioTenant],
    )).rejects.toMatchObject({ code: '23514' });
    await client.query(
      `UPDATE sms_provider_configs
          SET account_sid = 'AC123', enabled = TRUE
        WHERE tenant_id = $1`,
      [twilioTenant],
    );

    await client.query(upgrade711);
    const enabled = await client.query(
      'SELECT provider FROM sms_provider_configs WHERE enabled IS TRUE ORDER BY provider',
    );
    expect(enabled.rows).toEqual([{ provider: 'msg91' }, { provider: 'twilio' }]);
  });
});
