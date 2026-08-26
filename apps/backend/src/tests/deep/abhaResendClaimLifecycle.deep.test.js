/**
 * Migration-716 resend-claim lifecycle regression against real constraints.
 *
 * A legal in-flight resend lease may be stranded by a process crash. Terminal
 * cancellation/expiry must clear that lease in the same UPDATE that changes
 * status, otherwise chk_abha_enrolment_resend_claim rejects the statement.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import pg from 'pg';

jest.setTimeout(60_000);

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RUNTIME_ROLE = 'rls_http_test_app';

function token() {
  return randomUUID().replaceAll('-', '');
}

describeIfDb('ABHA stranded resend claims under migration 716', () => {
  let owner;
  let runtime;
  let enrolmentService;
  let runInTenantContext;
  let tenantId;
  let cancelSessionId;
  let claimedExpirySessionId;
  let ordinaryExpirySessionId;
  let cancelPatientUid;
  const patientUids = [randomUUID(), randomUUID(), randomUUID()];

  const savedEnv = {
    databaseUrl: process.env.DATABASE_URL,
    enforceRls: process.env.AUTH_ENFORCE_TENANT_RLS,
    runtimeRole: process.env.AUTH_TENANT_RLS_RUNTIME_ROLE,
    testRole: process.env.AUTH_TENANT_RLS_TEST_ROLE,
  };

  async function asOwnerTenant(fn) {
    await owner.query('BEGIN');
    try {
      await owner.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId],
      );
      const result = await fn(owner);
      await owner.query('COMMIT');
      return result;
    } catch (err) {
      await owner.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async function insertSession(client, {
    patientUid, txnId, expiresAt, status = 'otp_sent',
    verificationClaimId = null, resendClaimId = null,
  }) {
    const result = await client.query(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, txn_id, status,
          otp_sent_at, expires_at, resend_count,
          verification_claim_id, verification_claimed_at,
          resend_claim_id, resend_claimed_at)
       VALUES ($1::uuid, $2::uuid, 'aadhaar_otp', 'sandbox', $3::text,
               $4::text, NOW(), $5::timestamptz,
               CASE WHEN $7::uuid IS NULL THEN 0 ELSE 1 END,
               $6::uuid,
               CASE WHEN $6::uuid IS NULL THEN NULL ELSE NOW() - INTERVAL '10 minutes' END,
               $7::uuid,
               CASE WHEN $7::uuid IS NULL THEN NULL ELSE NOW() - INTERVAL '10 minutes' END)
       RETURNING id`,
      [
        tenantId, patientUid, txnId, status, expiresAt,
        verificationClaimId, resendClaimId,
      ],
    );
    return Number(result.rows[0].id);
  }

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();

    const role = await owner.query(
      `SELECT rolsuper, rolbypassrls
         FROM pg_roles
        WHERE rolname = $1`,
      [RUNTIME_ROLE],
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.searchParams.append('options', `-c role=${RUNTIME_ROLE}`);
    runtime = new pg.Client({ connectionString: runtimeUrl.toString() });
    await runtime.connect();
    const posture = await runtime.query('SELECT current_user');
    expect(posture.rows[0].current_user).toBe(RUNTIME_ROLE);

    process.env.DATABASE_URL = runtimeUrl.toString();
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

    tenantId = randomUUID();
    cancelPatientUid = patientUids[0];
    await owner.query(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'ABHA resend-claim regression', '{}'::jsonb)`,
      [tenantId, `abha-claim-${token()}`],
    );

    await asOwnerTenant(async (client) => {
      for (const patientUid of patientUids) {
        await client.query(
          `INSERT INTO users (uid, tenant_id, updated_at)
           VALUES ($1::uuid, $2::uuid, NOW())`,
          [patientUid, tenantId],
        );
      }

      cancelSessionId = await insertSession(client, {
        patientUid: patientUids[0],
        txnId: `txn-cancel-${token()}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        resendClaimId: randomUUID(),
      });
      claimedExpirySessionId = await insertSession(client, {
        patientUid: patientUids[1],
        txnId: `txn-claimed-expiry-${token()}`,
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        resendClaimId: randomUUID(),
      });
      ordinaryExpirySessionId = await insertSession(client, {
        patientUid: patientUids[2],
        txnId: `txn-ordinary-expiry-${token()}`,
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        status: 'otp_verifying',
        verificationClaimId: randomUUID(),
      });
    });

    ({ default: enrolmentService } = await import('../../services/abdm/abhaEnrolmentService.js'));
    ({ runInTenantContext } = await import('../../lib/tenantContext.js'));
  });

  afterAll(async () => {
    if (owner && tenantId) {
      await asOwnerTenant(async (client) => {
        await client.query(
          'DELETE FROM abha_enrolment_sessions WHERE tenant_id = $1::uuid',
          [tenantId],
        );
        await client.query(
          'DELETE FROM users WHERE tenant_id = $1::uuid AND uid = ANY($2::uuid[])',
          [tenantId, patientUids],
        );
      }).catch(() => {});
      await owner.query('DELETE FROM tenants WHERE id = $1::uuid', [tenantId]).catch(() => {});
    }
    await runtime?.end().catch(() => {});
    await owner?.end().catch(() => {});
    if (savedEnv.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedEnv.databaseUrl;
    if (savedEnv.enforceRls === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedEnv.enforceRls;
    if (savedEnv.runtimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = savedEnv.runtimeRole;
    if (savedEnv.testRole === undefined) delete process.env.AUTH_TENANT_RLS_TEST_ROLE;
    else process.env.AUTH_TENANT_RLS_TEST_ROLE = savedEnv.testRole;
  });

  it('cancels an otp_sent session and clears a stranded resend lease atomically', async () => {
    const session = await runInTenantContext(tenantId, () => (
      enrolmentService.cancelEnrolment({
        tenantId,
        sessionId: cancelSessionId,
        patientUid: cancelPatientUid,
      })
    ));

    expect(session.status).toBe('cancelled');
    const stored = await asOwnerTenant((client) => client.query(
      `SELECT status, verification_claim_id, verification_claimed_at,
              resend_claim_id, resend_claimed_at
         FROM abha_enrolment_sessions
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      [cancelSessionId, tenantId],
    ));
    expect(stored.rows[0]).toEqual({
      status: 'cancelled',
      verification_claim_id: null,
      verification_claimed_at: null,
      resend_claim_id: null,
      resend_claimed_at: null,
    });
  });

  it('expires ordinary and stranded-claim rows in one statement without rolling back the batch', async () => {
    const result = await enrolmentService.sweepExpiredEnrolmentSessions();
    expect(result.expired).toBeGreaterThanOrEqual(2);

    const expired = await asOwnerTenant((client) => client.query(
      `SELECT id, status,
              verification_claim_id, verification_claimed_at,
              resend_claim_id, resend_claimed_at
         FROM abha_enrolment_sessions
        WHERE id = ANY($1::int[])
        ORDER BY id`,
      [[claimedExpirySessionId, ordinaryExpirySessionId]],
    ));
    expect(expired.rows).toHaveLength(2);
    for (const row of expired.rows) {
      expect(row).toEqual(expect.objectContaining({
        status: 'expired',
        verification_claim_id: null,
        verification_claimed_at: null,
        resend_claim_id: null,
        resend_claimed_at: null,
      }));
    }
  });
});
