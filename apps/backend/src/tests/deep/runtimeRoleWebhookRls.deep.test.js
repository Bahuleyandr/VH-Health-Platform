/**
 * Runtime-role regression for the pre-tenant payment resolver and the three
 * bounded fleet-wide expiry capabilities introduced by migration 736.
 *
 * The fixture role deliberately retains table DML grants so the negative
 * assertions exercise FORCE RLS rather than failing at the SQL privilege
 * layer. Even after setting both the legacy system-job literal and the
 * forbidden tenant bypass literal, direct cross-tenant updates must see no
 * rows. The only fleet-wide transitions available to runtime are the three
 * parameterless owner routines.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import pg from 'pg';

jest.setTimeout(60_000);

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RUNTIME_ROLE = `rls_sweep_regression_${process.pid}`;
const ROUTINES = [
  'sweep_expired_abha_enrolment_sessions',
  'sweep_expired_abdm_share_intakes',
  'sweep_expired_payment_gateway_orders',
];

function token() {
  return randomUUID().replaceAll('-', '');
}

function timestamp(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

describeIfDb('bounded cross-tenant sweeps under a sealed runtime role', () => {
  let owner;
  let ownerPosture;
  let tenantIds;
  let userIds;
  let webhookToken;
  let executeBeforeGrant;
  const fixtureIds = {};

  async function ownerQuery(text, params = []) {
    return owner.query(text, params);
  }

  async function asRuntimeRole(options, fn) {
    const { tenantGuc = null, legacySystemJob = false, commit = false } = options || {};
    const client = new pg.Client({ connectionString: databaseUrl });
    let transactionFinished = false;
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
      if (tenantGuc !== null) {
        await client.query(
          "SELECT set_config('app.current_tenant_id', $1, true)",
          [tenantGuc],
        );
      }
      if (legacySystemJob) {
        await client.query(
          "SELECT set_config('app.rls_system_job', 'cross_tenant_sweep', true)",
        );
      }
      const result = await fn(client);
      await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      transactionFinished = true;
      return result;
    } finally {
      if (!transactionFinished) {
        await client.query('ROLLBACK').catch(() => {});
      }
      await client.end().catch(() => {});
    }
  }

  async function insertAbhaSession({ tenantId, patientUid, status, expiresAt, claim }) {
    const verificationClaimId = claim === 'verification' ? randomUUID() : null;
    const resendClaimId = claim === 'resend' ? randomUUID() : null;
    const result = await ownerQuery(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, txn_id, status,
          otp_sent_at, expires_at, resend_count,
          verification_claim_id, verification_claimed_at,
          resend_claim_id, resend_claimed_at)
       VALUES ($1::uuid, $2::uuid, 'aadhaar_otp', 'sandbox', $3::text, $4::text,
               NOW(), $5::timestamptz, CASE WHEN $7::uuid IS NULL THEN 0 ELSE 1 END,
               $6::uuid, CASE WHEN $6::uuid IS NULL THEN NULL ELSE NOW() END,
               $7::uuid, CASE WHEN $7::uuid IS NULL THEN NULL ELSE NOW() END)
       RETURNING id`,
      [
        tenantId,
        patientUid,
        `txn-${token()}`,
        status,
        expiresAt,
        verificationClaimId,
        resendClaimId,
      ],
    );
    return Number(result.rows[0].id);
  }

  async function insertShareIntake({ tenantId, status, expiresAt }) {
    const result = await ownerQuery(
      `INSERT INTO abdm_patient_share_intakes
         (tenant_id, environment, request_id, status, received_at, expires_at)
       VALUES ($1::uuid, 'sandbox', $2::text, $3::text, NOW(), $4::timestamptz)
       RETURNING id`,
      [tenantId, `request-${token()}`, status, expiresAt],
    );
    return Number(result.rows[0].id);
  }

  async function insertGatewayOrder({ tenantId, status, expiresAt }) {
    const result = await ownerQuery(
      `INSERT INTO payment_gateway_orders
         (tenant_id, provider, environment, patient_uid, amount, currency,
          receipt, status, expires_at, webhook_credential_version)
       VALUES ($1::uuid, 'dry_run', 'sandbox', $2::uuid, 500.00, 'INR',
               $3::text, $4::text, $5::timestamptz, 1)
       RETURNING id`,
      [tenantId, randomUUID(), `receipt-${token().slice(0, 24)}`, status, expiresAt],
    );
    return Number(result.rows[0].id);
  }

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();

    const posture = await ownerQuery(
      `SELECT role.rolname AS current_user, role.rolsuper, role.rolbypassrls
         FROM pg_catalog.pg_roles AS role
        WHERE role.rolname = CURRENT_USER`,
    );
    ownerPosture = posture.rows[0];
    expect(ownerPosture.rolsuper || ownerPosture.rolbypassrls).toBe(true);

    await ownerQuery(`
      DO $create_runtime_role$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${RUNTIME_ROLE}'
        ) THEN
          CREATE ROLE ${RUNTIME_ROLE} LOGIN;
        END IF;
      END
      $create_runtime_role$;
    `);
    await ownerQuery(
      `ALTER ROLE ${RUNTIME_ROLE}
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
    await ownerQuery(`GRANT ${RUNTIME_ROLE} TO CURRENT_USER`);

    executeBeforeGrant = await ownerQuery(
      `SELECT routine.proname,
              pg_catalog.has_function_privilege($1, routine.oid, 'EXECUTE') AS can_execute
         FROM pg_catalog.pg_proc AS routine
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'public'
          AND routine.proname = ANY($2::text[])
        ORDER BY routine.proname`,
      [RUNTIME_ROLE, ROUTINES],
    );

    await ownerQuery(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
    await ownerQuery(
      `GRANT SELECT, INSERT, UPDATE ON
         payment_gateway_provider_configs,
         abha_enrolment_sessions,
         abdm_patient_share_intakes,
         payment_gateway_orders
       TO ${RUNTIME_ROLE}`,
    );
    await ownerQuery(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`,
    );
    await ownerQuery(
      `GRANT EXECUTE ON FUNCTION public.resolve_payment_webhook_tenant(TEXT)
         TO ${RUNTIME_ROLE}`,
    );
    for (const routine of ROUTINES) {
      await ownerQuery(
        `GRANT EXECUTE ON FUNCTION public.${routine}() TO ${RUNTIME_ROLE}`,
      );
    }

    tenantIds = [randomUUID(), randomUUID()];
    userIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    webhookToken = token();

    for (const [index, tenantId] of tenantIds.entries()) {
      await ownerQuery(
        `INSERT INTO tenants (id, slug, name, settings)
         VALUES ($1::uuid, $2::text, $3::text, '{}'::jsonb)`,
        [tenantId, `bounded-sweep-${index}-${token()}`, `Bounded sweep tenant ${index}`],
      );
    }
    for (let index = 0; index < userIds.length; index += 1) {
      await ownerQuery(
        `INSERT INTO users (uid, tenant_id, updated_at)
         VALUES ($1::uuid, $2::uuid, NOW())`,
        [userIds[index], tenantIds[index < 2 ? 0 : 1]],
      );
    }

    await ownerQuery(
      `INSERT INTO payment_gateway_provider_configs
         (tenant_id, provider, environment, metadata)
       VALUES ($1::uuid, 'dry_run', 'sandbox',
               pg_catalog.jsonb_build_object('webhook_token', $2::text))`,
      [tenantIds[0], webhookToken],
    );

    fixtureIds.abhaStaleResend = await insertAbhaSession({
      tenantId: tenantIds[0], patientUid: userIds[0], status: 'otp_sent',
      expiresAt: timestamp(-1), claim: 'resend',
    });
    fixtureIds.abhaFresh = await insertAbhaSession({
      tenantId: tenantIds[0], patientUid: userIds[1], status: 'otp_sent',
      expiresAt: timestamp(1), claim: null,
    });
    fixtureIds.abhaStaleVerification = await insertAbhaSession({
      tenantId: tenantIds[1], patientUid: userIds[2], status: 'otp_verifying',
      expiresAt: timestamp(-1), claim: 'verification',
    });
    fixtureIds.abhaOtherState = await insertAbhaSession({
      tenantId: tenantIds[1], patientUid: userIds[3], status: 'failed',
      expiresAt: timestamp(-1), claim: null,
    });

    fixtureIds.shareStaleA = await insertShareIntake({
      tenantId: tenantIds[0], status: 'received', expiresAt: timestamp(-1),
    });
    fixtureIds.shareStaleB = await insertShareIntake({
      tenantId: tenantIds[1], status: 'received', expiresAt: timestamp(-1),
    });
    fixtureIds.shareFresh = await insertShareIntake({
      tenantId: tenantIds[0], status: 'received', expiresAt: timestamp(1),
    });
    fixtureIds.shareOtherState = await insertShareIntake({
      tenantId: tenantIds[1], status: 'dismissed', expiresAt: timestamp(-1),
    });

    fixtureIds.paymentStaleA = await insertGatewayOrder({
      tenantId: tenantIds[0], status: 'created', expiresAt: timestamp(-1),
    });
    fixtureIds.paymentStaleB = await insertGatewayOrder({
      tenantId: tenantIds[1], status: 'attempted', expiresAt: timestamp(-1),
    });
    fixtureIds.paymentFresh = await insertGatewayOrder({
      tenantId: tenantIds[0], status: 'created', expiresAt: timestamp(1),
    });
    fixtureIds.paymentOtherState = await insertGatewayOrder({
      tenantId: tenantIds[1], status: 'cancelled', expiresAt: timestamp(-1),
    });
  });

  afterAll(async () => {
    if (!owner) return;
    await ownerQuery('ROLLBACK').catch(() => {});
    for (const tenantId of tenantIds || []) {
      await ownerQuery('DELETE FROM tenants WHERE id = $1::uuid', [tenantId]).catch(() => {});
    }
    await ownerQuery(`DROP OWNED BY ${RUNTIME_ROLE}`).catch(() => {});
    await ownerQuery(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`).catch(() => {});
    await owner.end().catch(() => {});
  });

  it('seals the runtime role and exposes only locked parameterless owner routines', async () => {
    const role = await ownerQuery(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
              rolreplication, rolinherit
         FROM pg_catalog.pg_roles
        WHERE rolname = $1`,
      [RUNTIME_ROLE],
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolinherit: false,
    });
    expect(executeBeforeGrant.rows).toHaveLength(3);
    expect(executeBeforeGrant.rows.every((row) => row.can_execute === false)).toBe(true);

    const routines = await ownerQuery(
      `SELECT routine.proname, routine.pronargs, routine.prosecdef,
              routine.proconfig, owner.rolname AS owner_name,
              owner.rolsuper OR owner.rolbypassrls AS owner_is_privileged,
              pg_catalog.has_function_privilege($1, routine.oid, 'EXECUTE') AS runtime_execute
         FROM pg_catalog.pg_proc AS routine
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
         JOIN pg_catalog.pg_roles AS owner ON owner.oid = routine.proowner
        WHERE namespace.nspname = 'public'
          AND routine.proname LIKE 'sweep_expired_%'
        ORDER BY routine.proname`,
      [RUNTIME_ROLE],
    );
    expect(routines.rows.map((row) => row.proname)).toEqual([...ROUTINES].sort());
    for (const routine of routines.rows) {
      expect(routine).toEqual(expect.objectContaining({
        pronargs: 0,
        prosecdef: true,
        owner_name: ownerPosture.current_user,
        owner_is_privileged: true,
        runtime_execute: true,
      }));
      expect(routine.proconfig).toEqual(expect.arrayContaining([
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
      ]));
    }
  });

  it('keeps pre-tenant provider rows hidden and resolves only tenant identity through 732', async () => {
    const plain = await asRuntimeRole({}, (client) => client.query(
      `SELECT tenant_id
         FROM payment_gateway_provider_configs
        WHERE metadata->>'webhook_token' = $1`,
      [webhookToken],
    ));
    expect(plain.rowCount).toBe(0);

    const resolved = await asRuntimeRole({}, (client) => client.query(
      `SELECT tenant_id, config_id
         FROM public.resolve_payment_webhook_tenant($1)`,
      [webhookToken],
    ));
    expect(resolved.rowCount).toBe(1);
    expect(resolved.rows[0]).toEqual(expect.objectContaining({
      tenant_id: tenantIds[0],
    }));
    expect(Number.isInteger(resolved.rows[0].config_id)).toBe(true);
  });

  it('denies direct fleet-wide updates even after caller-settable bypass literals', async () => {
    const updates = await asRuntimeRole(
      { tenantGuc: 'bypass', legacySystemJob: true },
      async (client) => {
        const results = [];
        results.push(await client.query(
          `UPDATE abha_enrolment_sessions SET updated_at = NOW()
            WHERE status IN ('initiated', 'otp_sent', 'otp_verifying', 'otp_verified')`,
        ));
        results.push(await client.query(
          `UPDATE abdm_patient_share_intakes SET updated_at = NOW()
            WHERE status = 'received'`,
        ));
        results.push(await client.query(
          `UPDATE payment_gateway_orders SET updated_at = NOW()
            WHERE status IN ('created', 'attempted')`,
        ));
        return results;
      },
    );
    expect(updates.map((result) => result.rowCount)).toEqual([0, 0, 0]);
  });

  it('expires only stale live ABHA sessions across tenants and clears both claim types', async () => {
    const swept = await asRuntimeRole({ commit: true }, (client) => client.query(
      'SELECT public.sweep_expired_abha_enrolment_sessions() AS expired',
    ));
    expect(Number(swept.rows[0].expired)).toBeGreaterThanOrEqual(2);

    const rows = await ownerQuery(
      `SELECT id, status, verification_claim_id, verification_claimed_at,
              resend_claim_id, resend_claimed_at
         FROM abha_enrolment_sessions
        WHERE id = ANY($1::int[])
        ORDER BY id`,
      [[
        fixtureIds.abhaStaleResend,
        fixtureIds.abhaFresh,
        fixtureIds.abhaStaleVerification,
        fixtureIds.abhaOtherState,
      ]],
    );
    const byId = new Map(rows.rows.map((row) => [Number(row.id), row]));
    for (const id of [fixtureIds.abhaStaleResend, fixtureIds.abhaStaleVerification]) {
      expect(byId.get(id)).toEqual(expect.objectContaining({
        status: 'expired',
        verification_claim_id: null,
        verification_claimed_at: null,
        resend_claim_id: null,
        resend_claimed_at: null,
      }));
    }
    expect(byId.get(fixtureIds.abhaFresh).status).toBe('otp_sent');
    expect(byId.get(fixtureIds.abhaOtherState).status).toBe('failed');
  });

  it('expires only stale received share intakes across tenants', async () => {
    const swept = await asRuntimeRole({ commit: true }, (client) => client.query(
      'SELECT public.sweep_expired_abdm_share_intakes() AS expired',
    ));
    expect(Number(swept.rows[0].expired)).toBeGreaterThanOrEqual(2);

    const rows = await ownerQuery(
      `SELECT id, status
         FROM abdm_patient_share_intakes
        WHERE id = ANY($1::int[])`,
      [[
        fixtureIds.shareStaleA,
        fixtureIds.shareStaleB,
        fixtureIds.shareFresh,
        fixtureIds.shareOtherState,
      ]],
    );
    const byId = new Map(rows.rows.map((row) => [Number(row.id), row.status]));
    expect(byId.get(fixtureIds.shareStaleA)).toBe('expired');
    expect(byId.get(fixtureIds.shareStaleB)).toBe('expired');
    expect(byId.get(fixtureIds.shareFresh)).toBe('received');
    expect(byId.get(fixtureIds.shareOtherState)).toBe('dismissed');
  });

  it('expires only stale created/attempted gateway orders across tenants', async () => {
    const swept = await asRuntimeRole({ commit: true }, (client) => client.query(
      'SELECT public.sweep_expired_payment_gateway_orders() AS expired',
    ));
    expect(Number(swept.rows[0].expired)).toBeGreaterThanOrEqual(2);

    const rows = await ownerQuery(
      `SELECT id, status
         FROM payment_gateway_orders
        WHERE id = ANY($1::int[])`,
      [[
        fixtureIds.paymentStaleA,
        fixtureIds.paymentStaleB,
        fixtureIds.paymentFresh,
        fixtureIds.paymentOtherState,
      ]],
    );
    const byId = new Map(rows.rows.map((row) => [Number(row.id), row.status]));
    expect(byId.get(fixtureIds.paymentStaleA)).toBe('expired');
    expect(byId.get(fixtureIds.paymentStaleB)).toBe('expired');
    expect(byId.get(fixtureIds.paymentFresh)).toBe('created');
    expect(byId.get(fixtureIds.paymentOtherState)).toBe('cancelled');
  });
});
