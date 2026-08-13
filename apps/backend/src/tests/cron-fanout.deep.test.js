import { randomUUID } from 'node:crypto';
import pg from 'pg';

import prisma, { setTenant } from '../lib/prisma.js';
import { runForEachTenant } from '../utils/tenantFanout.js';
import { getCurrentTenantId } from '../lib/tenantContext.js';

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const STALE_TENANT = randomUUID();

function databaseSqlState(error) {
  return error?.meta?.driverAdapterError?.cause?.originalCode
    || error?.meta?.code
    || error?.code;
}

async function tenantOutcome(runId, tenantId) {
  const rows = await setTenant(tenantId, tx => tx.$queryRawUnsafe(
    `SELECT status, failure_code, finished_at
       FROM scheduled_job_tenant_runs
      WHERE run_id = $1::bigint
        AND tenant_id = $2::uuid`,
    runId,
    tenantId,
  ));
  return rows[0];
}

describe('truthful per-tenant cron fan-out', () => {
  beforeAll(async () => {
    const suffix = String(Date.now() % 100000);
    for (const [id, slug] of [[TENANT_A, 'fanout-a'], [TENANT_B, 'fanout-b']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants
           (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET status = 'active'`,
        id,
        `${slug}-${suffix}`,
        slug,
      );
    }
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE tenants
          SET status = 'suspended', updated_at = NOW()
        WHERE id IN ($1::uuid, $2::uuid, $3::uuid)`,
      TENANT_A,
      TENANT_B,
      STALE_TENANT,
    );
    await prisma.$disconnect();
  }, 30000);

  it('discovers every active tenant, runs in its context, and persists success before resolving', async () => {
    const activeRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM tenants WHERE status = 'active' ORDER BY id`,
    );
    const seen = [];
    const result = await runForEachTenant(`fanout-success-${Date.now()}`, (tenantId) => {
      seen.push({ tenantId, context: getCurrentTenantId() });
    });

    expect(seen.every(row => row.context === row.tenantId)).toBe(true);
    expect(seen.map(row => row.tenantId)).toEqual(activeRows.map(row => row.id));
    expect(result).toMatchObject({
      tenantsDiscovered: activeRows.length,
      tenantsRun: activeRows.length,
      errors: 0,
    });

    const [run] = await prisma.$queryRawUnsafe(
      `SELECT discovery_status, aggregate_status, tenants_discovered,
              tenants_succeeded, tenants_failed, finished_at
         FROM scheduled_job_runs
        WHERE id = $1::bigint`,
      BigInt(result.runId),
    );
    expect(run).toMatchObject({
      discovery_status: 'succeeded',
      aggregate_status: 'succeeded',
      tenants_discovered: activeRows.length,
      tenants_succeeded: activeRows.length,
      tenants_failed: 0,
      finished_at: expect.any(Date),
    });
    expect(await tenantOutcome(BigInt(result.runId), TENANT_A)).toMatchObject({
      status: 'succeeded',
      failure_code: null,
      finished_at: expect.any(Date),
    });
  }, 30000);

  it('continues healthy tenants, persists each outcome, and rejects the aggregate', async () => {
    let ranForB = false;
    let aggregate;
    try {
      await runForEachTenant(`fanout-partial-${Date.now()}`, (tenantId) => {
        if (tenantId === TENANT_A) {
          const err = new Error('tenant A unavailable');
          err.code = 'TENANT_A_UNAVAILABLE';
          throw err;
        }
        if (tenantId === TENANT_B) ranForB = true;
      });
      throw new Error('Expected fan-out to reject');
    } catch (err) {
      aggregate = err;
    }

    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.name).toBe('TenantFanoutAggregateError');
    expect(aggregate.message).toMatch(/1 tenant run\(s\) failed/);
    expect(ranForB).toBe(true);

    const [run] = await prisma.$queryRawUnsafe(
      `SELECT discovery_status, aggregate_status, tenants_discovered,
              tenants_succeeded, tenants_failed, finished_at
         FROM scheduled_job_runs
        WHERE id = $1::bigint`,
      BigInt(aggregate.runId),
    );
    expect(run).toMatchObject({
      discovery_status: 'succeeded',
      aggregate_status: 'partial_failure',
      tenants_failed: 1,
      finished_at: expect.any(Date),
    });
    expect(run.tenants_succeeded + run.tenants_failed).toBe(run.tenants_discovered);
    expect(await tenantOutcome(BigInt(aggregate.runId), TENANT_A)).toMatchObject({
      status: 'failed',
      failure_code: 'TENANT_A_UNAVAILABLE',
      finished_at: expect.any(Date),
    });
    expect(await tenantOutcome(BigInt(aggregate.runId), TENANT_B)).toMatchObject({
      status: 'succeeded',
      failure_code: null,
      finished_at: expect.any(Date),
    });
  }, 30000);

  it('reconciles a crash-stale run as abandoned before starting the next run', async () => {
    const [staleRun] = await prisma.$queryRawUnsafe(
      `INSERT INTO scheduled_job_runs
         (job_label, lock_key, discovery_status, tenants_discovered, started_at)
       VALUES ($1::text, $1::text, 'succeeded', 1, NOW() - INTERVAL '2 days')
       RETURNING id`,
      `fanout-stale-${Date.now()}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'Stale tenant', 'IN', 'DPDP', 'suspended', '{}'::jsonb, NOW(), NOW())`,
      STALE_TENANT,
      `fanout-stale-${Date.now()}`,
    );
    await setTenant(STALE_TENANT, tx => tx.$executeRawUnsafe(
      `INSERT INTO scheduled_job_tenant_runs (run_id, tenant_id)
       VALUES ($1::bigint, $2::uuid)`,
      staleRun.id,
      STALE_TENANT,
    ));
    const result = await runForEachTenant(`different-live-label-${Date.now()}`, async () => {});
    const [parent] = await prisma.$queryRawUnsafe(
      `SELECT aggregate_status, tenants_unresolved, failure_code, finished_at
         FROM scheduled_job_runs WHERE id = $1::bigint`,
      staleRun.id,
    );
    expect(parent).toMatchObject({
      aggregate_status: 'abandoned',
      tenants_unresolved: 1,
      failure_code: 'STALE_RUN_ABANDONED',
      finished_at: expect.any(Date),
    });
    expect(await tenantOutcome(staleRun.id, STALE_TENANT)).toMatchObject({
      status: 'indeterminate',
      failure_code: 'STALE_RUN_ABANDONED',
    });
  }, 30000);

  it('rejects parent success without matching tenant receipts', async () => {
    const [unbackedRun] = await prisma.$queryRawUnsafe(
      `INSERT INTO scheduled_job_runs
         (job_label, lock_key, discovery_status, tenants_discovered)
       VALUES ($1::text, $1::text, 'succeeded', 1)
       RETURNING id`,
      `fanout-unbacked-${Date.now()}`,
    );
    let rejection;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE scheduled_job_runs
            SET aggregate_status = 'succeeded',
                tenants_succeeded = 1,
                finished_at = NOW()
          WHERE id = $1::bigint`,
        unbackedRun.id,
      );
    } catch (err) {
      rejection = err;
    }
    expect(databaseSqlState(rejection)).toBe('23514');

    const [parent] = await prisma.$queryRawUnsafe(
      `SELECT aggregate_status, tenants_succeeded, finished_at
         FROM scheduled_job_runs
        WHERE id = $1::bigint`,
      unbackedRun.id,
    );
    expect(parent).toMatchObject({
      aggregate_status: 'running',
      tenants_succeeded: 0,
      finished_at: null,
    });
  }, 30000);

  it('does not abandon an old run while its fleet lock proves the job is live', async () => {
    const liveLabel = `fanout-live-lock-${Date.now()}`;
    const [liveRun] = await prisma.$queryRawUnsafe(
      `INSERT INTO scheduled_job_runs (job_label, lock_key, started_at)
       VALUES ($1::text, $1::text, NOW() - INTERVAL '2 days')
       RETURNING id`,
      liveLabel,
    );
    const lockClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await lockClient.connect();
    try {
      const lock = await lockClient.query(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked',
        [0x5648, liveLabel],
      );
      expect(lock.rows[0].locked).toBe(true);

      await runForEachTenant(`fanout-live-peer-${Date.now()}`, async () => {});
      const [parent] = await prisma.$queryRawUnsafe(
        `SELECT aggregate_status, finished_at
           FROM scheduled_job_runs
          WHERE id = $1::bigint`,
        liveRun.id,
      );
      expect(parent).toEqual({ aggregate_status: 'running', finished_at: null });
    } finally {
      await lockClient.query(
        'SELECT pg_advisory_unlock($1, hashtext($2))',
        [0x5648, liveLabel],
      );
      await lockClient.end();
    }
  }, 30000);
});
