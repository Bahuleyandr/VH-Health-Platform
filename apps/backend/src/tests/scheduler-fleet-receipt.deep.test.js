import { randomUUID } from 'node:crypto';

import prisma from '../lib/prisma.js';
import { runFleetJob } from '../utils/tenantFanout.js';

// Migration 671 gives single-pass fleet sweeps (audit-chain verification,
// results-inbox escalation) the durable receipt that 668 only gave to
// per-tenant fan-outs. withJobLock logs and swallows whatever these jobs
// throw, so the run row is the only thing that distinguishes "the tick failed"
// from "the tick never fired".

const label = suffix => `fleet-receipt-test-${suffix}-${randomUUID().slice(0, 8)}`;

async function readRun(runId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, job_label, lock_key, scope, discovery_status, aggregate_status,
            tenants_discovered, tenants_succeeded, tenants_failed,
            tenants_unresolved, failure_code, finished_at
       FROM scheduled_job_runs
      WHERE id = $1::bigint`,
    BigInt(runId),
  );
  return rows[0];
}

describe('fleet scheduled-job receipts (migration 671)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('records a completed fleet sweep with no tenant dimension', async () => {
    const jobLabel = label('ok');
    const { runId, result } = await runFleetJob(jobLabel, async () => ({ swept: 3 }));

    expect(result).toEqual({ swept: 3 });
    const run = await readRun(runId);
    expect(run).toMatchObject({
      job_label: jobLabel,
      lock_key: jobLabel,
      scope: 'fleet',
      discovery_status: 'pending',
      aggregate_status: 'succeeded',
      tenants_discovered: 0,
      tenants_succeeded: 0,
      tenants_failed: 0,
      tenants_unresolved: 0,
      failure_code: null,
    });
    expect(run.finished_at).toBeInstanceOf(Date);
  });

  it('records job_failed with the failure code and rejects, never a silent tick', async () => {
    const jobLabel = label('fail');
    const bodyError = new Error('audit chain verifier unavailable');
    bodyError.code = 'AUDIT_CHAIN_VERIFICATION_INCOMPLETE';

    let thrown;
    try {
      await runFleetJob(jobLabel, async () => { throw bodyError; });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.name).toBe('TenantFanoutAggregateError');
    expect(thrown.message).toBe(`${jobLabel}: fleet job failed`);
    expect(thrown.errors).toContain(bodyError);

    const run = await readRun(thrown.runId);
    expect(run).toMatchObject({
      scope: 'fleet',
      discovery_status: 'pending',
      aggregate_status: 'job_failed',
      failure_code: 'AUDIT_CHAIN_VERIFICATION_INCOMPLETE',
      tenants_discovered: 0,
    });
    expect(run.finished_at).toBeInstanceOf(Date);
  });

  it('refuses a fleet receipt that claims tenant work it never did', async () => {
    const jobLabel = label('fabricated');
    const { runId } = await runFleetJob(jobLabel, async () => null);

    await expect(prisma.$executeRawUnsafe(
      `UPDATE scheduled_job_runs
          SET tenants_discovered = 4, tenants_succeeded = 4
        WHERE id = $1::bigint`,
      BigInt(runId),
    )).rejects.toThrow();

    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO scheduled_job_runs (job_label, lock_key, scope, discovery_status,
                                       aggregate_status, tenants_discovered,
                                       tenants_succeeded, finished_at)
       VALUES ($1::text, $1::text, 'fleet', 'succeeded', 'succeeded', 1, 1, NOW())`,
      `${jobLabel}-forged`,
    )).rejects.toThrow();
  });

  it('keeps job_failed unreachable for a tenant fan-out receipt', async () => {
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO scheduled_job_runs (job_label, lock_key, scope, discovery_status,
                                       aggregate_status, failure_code, finished_at)
       VALUES ($1::text, $1::text, 'tenant_fanout', 'pending', 'job_failed', 'X', NOW())`,
      label('fanout-job-failed'),
    )).rejects.toThrow();
  });

  it('rejects an unknown scope', async () => {
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO scheduled_job_runs (job_label, lock_key, scope)
       VALUES ($1::text, $1::text, 'per_facility')`,
      label('bad-scope'),
    )).rejects.toThrow();
  });
});
