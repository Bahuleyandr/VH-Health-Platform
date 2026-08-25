/**
 * T-M1 — runtime-role (NOBYPASSRLS) regression for the pre-tenant webhook /
 * ABDM callback / expiry-sweep paths under migration 726's fail-closed RLS.
 *
 * WHY THIS SUITE EXISTS. Migration 726 put the payment + ABDM callback tables
 * under FORCE + AS RESTRICTIVE RLS that rejects an unset/'bypass' tenant GUC.
 * The public webhook/callback mounts and the cross-tenant expiry sweeps ran on a
 * plain connection with no tenant context. That defect is INVISIBLE to the rest
 * of the suite because CI and the local rigs connect as a superuser / owner that
 * bypasses RLS even under FORCE (backend CLAUDE.md: CI's `vhhealth` "both owns
 * the tables and is the service container's superuser"; the deep RLS suites
 * reach a non-bypass role only via SET LOCAL ROLE inside setTenant transactions,
 * never on the unwrapped plain-connection path this class lives on).
 *
 * This suite reproduces the PROD posture: it creates a real NOSUPERUSER
 * NOBYPASSRLS login-capable role, SET LOCAL ROLEs to it, and drives the exact
 * DB artifacts the wave-B fixes add:
 *   * migration 732's owner-owned SECURITY DEFINER resolve_payment_webhook_tenant
 *     (the token->tenant lookup the webhook route needs before any tenant
 *     context exists), and
 *   * migration 733's system-job predicate that lets the cross-tenant sweeps run
 *     under app.rls_system_job='cross_tenant_sweep' without re-opening 'bypass'.
 *
 * FAIL-before / PASS-after: run against a DB migrated only through 731 and the
 * resolver assertions throw (function absent) and the system-job sweep sees 0
 * rows (no predicate) — every assertion below fails. Apply 732/733 and they
 * pass. That is the regression signal the shipped `webhookFinancialRlsMigration`
 * string-matching test cannot provide.
 *
 * Needs Postgres; self-skips when DATABASE_URL / TEST_DATABASE_URL are unset.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const RUNTIME_ROLE = 'rls_runtime_regression';
const SYSTEM_JOB_GUC = 'app.rls_system_job';
const SYSTEM_JOB_SWEEP = 'cross_tenant_sweep';

function tok() {
  return randomUUID().replaceAll('-', '');
}

describeIfDb('runtime-role NOBYPASSRLS webhook/ABDM/sweep RLS regression (T-M1)', () => {
  let owner;
  let tenantId;
  let webhookToken;
  let hasResolver = false;

  async function ownerQuery(text, params = []) {
    return owner.query(text, params);
  }

  // Open a fresh connection, downgrade to the NOBYPASSRLS role for the duration
  // of one transaction (mirrors the prod runtime posture), optionally pin the
  // tenant / system-job GUCs, run fn, then ROLLBACK so nothing persists.
  async function asRuntimeRole({ tenantGuc = null, systemJob = false }, fn) {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
      if (tenantGuc !== null) {
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantGuc]);
      }
      if (systemJob) {
        await client.query(`SELECT set_config('${SYSTEM_JOB_GUC}', $1, true)`, [SYSTEM_JOB_SWEEP]);
      }
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end().catch(() => {});
    }
  }

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();

    // Sealed non-owner runtime role — LOGIN so it is a faithful stand-in for
    // vhhealth_runtime, NOSUPERUSER + NOBYPASSRLS so RLS actually enforces.
    await ownerQuery(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
          CREATE ROLE ${RUNTIME_ROLE} LOGIN;
        END IF;
      END $$;
    `);
    await ownerQuery(`ALTER ROLE ${RUNTIME_ROLE} NOSUPERUSER NOBYPASSRLS`);
    // The connecting owner must be able to SET ROLE to it (creator has admin;
    // re-grant idempotently in case the role predates this run).
    await ownerQuery(`GRANT ${RUNTIME_ROLE} TO CURRENT_USER`).catch(() => {});
    await ownerQuery(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
    await ownerQuery(
      `GRANT SELECT, INSERT, UPDATE ON
         payment_gateway_provider_configs, abdm_patient_share_intakes
       TO ${RUNTIME_ROLE}`,
    );
    await ownerQuery(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
    // EXECUTE on the 732 resolver (REVOKEd from PUBLIC by that migration).
    // Tolerated-missing so the suite still runs — and fails — pre-732.
    const resolver = await ownerQuery(
      "SELECT 1 FROM pg_proc WHERE proname = 'resolve_payment_webhook_tenant'",
    );
    hasResolver = resolver.rowCount > 0;
    if (hasResolver) {
      await ownerQuery(
        `GRANT EXECUTE ON FUNCTION public.resolve_payment_webhook_tenant(TEXT) TO ${RUNTIME_ROLE}`,
      );
    }

    tenantId = randomUUID();
    webhookToken = tok();
    await ownerQuery(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'Runtime-role RLS regression', '{}'::jsonb)`,
      [tenantId, `rt-rls-${tok()}`],
    );

    // Seed one provider config (carrying the webhook token) and one already-
    // expired share intake, both scoped to the tenant. Set the tenant GUC in the
    // seed transaction so the writes satisfy 726's restrictive WITH CHECK even
    // when the owner is itself a non-bypass role.
    await ownerQuery('BEGIN');
    await ownerQuery("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await ownerQuery(
      `INSERT INTO payment_gateway_provider_configs (tenant_id, provider, environment, metadata)
       VALUES ($1::uuid, 'dry_run', 'sandbox', jsonb_build_object('webhook_token', $2::text))`,
      [tenantId, webhookToken],
    );
    await ownerQuery(
      `INSERT INTO abdm_patient_share_intakes
         (tenant_id, environment, request_id, status, received_at, expires_at)
       VALUES ($1::uuid, 'sandbox', $2::text, 'received', NOW(), NOW() - INTERVAL '1 hour')`,
      [tenantId, `req-${tok()}`],
    );
    await ownerQuery('COMMIT');
  }, 60_000);

  afterAll(async () => {
    if (!owner) return;
    await ownerQuery('ROLLBACK').catch(() => {});
    if (tenantId) {
      // ON DELETE CASCADE from tenants clears the seeded child rows.
      await ownerQuery('DELETE FROM tenants WHERE id = $1::uuid', [tenantId]).catch(() => {});
    }
    // Drop the runtime role so this suite leaves no ambient DB artifact behind:
    // a leaked NOBYPASSRLS login role would otherwise persist for the rest of the
    // session. DROP OWNED first revokes the grants this suite made to it, so
    // DROP ROLE cannot fail on dependent privileges. Best-effort — never let
    // teardown throw.
    await ownerQuery(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
           EXECUTE 'DROP OWNED BY ${RUNTIME_ROLE}';
           EXECUTE 'DROP ROLE IF EXISTS ${RUNTIME_ROLE}';
         END IF;
       END $$;`,
    ).catch(() => {});
    await owner.end().catch(() => {});
  });

  describe('T1 — payment webhook token resolution', () => {
    it('a plain cross-tenant token lookup returns 0 rows under RLS (the defect)', async () => {
      const rows = await asRuntimeRole({}, (c) => c.query(
        `SELECT tenant_id FROM payment_gateway_provider_configs
          WHERE metadata->>'webhook_token' = $1 LIMIT 1`,
        [webhookToken],
      ));
      expect(rows.rowCount).toBe(0);
    });

    it('the SECURITY DEFINER resolver returns the tenant (migration 732)', async () => {
      const rows = await asRuntimeRole({}, (c) => c.query(
        'SELECT tenant_id, config_id FROM resolve_payment_webhook_tenant($1)',
        [webhookToken],
      ));
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].tenant_id).toBe(tenantId);
      expect(Number.isInteger(rows.rows[0].config_id)).toBe(true);
    });

    it('the full config row is then readable under the resolved tenant GUC', async () => {
      const rows = await asRuntimeRole({ tenantGuc: tenantId }, (c) => c.query(
        `SELECT id, tenant_id FROM payment_gateway_provider_configs
          WHERE metadata->>'webhook_token' = $1 LIMIT 1`,
        [webhookToken],
      ));
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].tenant_id).toBe(tenantId);
    });
  });

  describe('T2 — ABDM share intake write', () => {
    it('an INSERT with no tenant context is rejected (42501)', async () => {
      await expect(
        asRuntimeRole({}, (c) => c.query(
          `INSERT INTO abdm_patient_share_intakes
             (tenant_id, environment, request_id, status, received_at, expires_at)
           VALUES ($1::uuid, 'sandbox', $2::text, 'received', NOW(), NOW() + INTERVAL '1 hour')`,
          [tenantId, `req-${tok()}`],
        )),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('the same INSERT succeeds under the tenant GUC (what setTenantTx supplies)', async () => {
      const res = await asRuntimeRole({ tenantGuc: tenantId }, (c) => c.query(
        `INSERT INTO abdm_patient_share_intakes
           (tenant_id, environment, request_id, status, received_at, expires_at)
         VALUES ($1::uuid, 'sandbox', $2::text, 'received', NOW(), NOW() + INTERVAL '1 hour')
         RETURNING id`,
        [tenantId, `req-${tok()}`],
      ));
      expect(res.rowCount).toBe(1);
    });
  });

  describe('T2 — cross-tenant expiry sweep', () => {
    it("a 'bypass'-only sweep UPDATE sees 0 rows (726 rejects bypass — the defect)", async () => {
      const res = await asRuntimeRole({ tenantGuc: 'bypass' }, (c) => c.query(
        `UPDATE abdm_patient_share_intakes SET updated_at = NOW()
          WHERE tenant_id = $1::uuid AND status = 'received' RETURNING id`,
        [tenantId],
      ));
      expect(res.rowCount).toBe(0);
    });

    it('the system-job GUC lets the cross-tenant sweep reach the row (migration 733)', async () => {
      const res = await asRuntimeRole({ tenantGuc: 'bypass', systemJob: true }, (c) => c.query(
        `UPDATE abdm_patient_share_intakes SET updated_at = NOW()
          WHERE tenant_id = $1::uuid AND status = 'received' RETURNING id`,
        [tenantId],
      ));
      expect(res.rowCount).toBeGreaterThan(0);
    });
  });
});
