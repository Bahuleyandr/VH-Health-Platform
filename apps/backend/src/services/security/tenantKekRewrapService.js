// src/services/security/tenantKekRewrapService.js
//
// Admin-triggered wrapper around scripts/phi-rewrap-tenant-keks.mjs. The
// service keeps the re-wrap logic importable for HTTP orchestration and tests;
// the script remains the CLI entry point.

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isEncrypted, getKeyId, rewrapField } from '../../utils/fieldEncryption.js';
import { loadTenantKekIntoProvider } from './tenantKekProvider.js';

export const PHI_REWRAP_MANIFEST = [
  { table: 'oauth_providers', id: 'id', tenant: 'tenant_id', cols: ['secret_cipher'] },
  { table: 'teleconsult_provider_configs', id: 'id', tenant: 'tenant_id', cols: ['api_key_ciphertext', 'api_secret_ciphertext', 'webhook_secret_ciphertext'] },
  { table: 'webhook_subscriptions', id: 'id', tenant: 'tenant_id', cols: ['signing_secret'] },
  { table: 'tenant_interop_secrets', id: 'id', tenant: 'tenant_id', cols: ['secret_ciphertext'] },
];

const BATCH = 500;
const JOBS = new Map();
const TERMINAL = new Set(['succeeded', 'failed']);

async function columnExists(table, col) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    table, col,
  );
  return rows.length > 0;
}

async function rewrapTable(tenantId, kid, entry, dryRun) {
  if (!(await columnExists(entry.table, entry.tenant))) {
    return { table: entry.table, scanned: 0, rewrapped: 0, skipped: true };
  }

  const cols = [];
  for (const col of entry.cols) {
    if (await columnExists(entry.table, col)) cols.push(col);
  }
  if (cols.length === 0) {
    return { table: entry.table, scanned: 0, rewrapped: 0, skipped: true };
  }

  let scanned = 0;
  let rewrapped = 0;
  let lastId = 0;
  for (;;) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${entry.id} AS _id, ${cols.join(', ')}
         FROM ${entry.table}
        WHERE ${entry.tenant} = $1::uuid
          AND ${entry.id} > $2
        ORDER BY ${entry.id} ASC
        LIMIT ${BATCH}`,
      tenantId, lastId,
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row._id;
      const sets = [];
      const params = [];
      for (const col of cols) {
        const value = row[col];
        if (isEncrypted(value) && getKeyId(value) !== kid && String(value).startsWith('enc:v2:')) {
          scanned += 1;
          params.push(rewrapField(value, { keyId: kid }));
          sets.push(`${col} = $${params.length}`);
        }
      }
      if (sets.length > 0) {
        rewrapped += sets.length;
        if (!dryRun) {
          params.push(row._id);
          await prisma.$executeRawUnsafe(
            `UPDATE ${entry.table} SET ${sets.join(', ')} WHERE ${entry.id} = $${params.length}`,
            ...params,
          );
        }
      }
    }
    if (rows.length < BATCH) break;
  }

  return { table: entry.table, scanned, rewrapped, skipped: false };
}

export async function runTenantKekRewrap({ tenantId, table = null, dryRun = false } = {}) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  // Re-wrap targets the tenant's CURRENT KEK version, not a fixed v1.
  const { keyId } = await loadTenantKekIntoProvider(tenantId);
  const manifest = table
    ? PHI_REWRAP_MANIFEST.filter((entry) => entry.table === table)
    : PHI_REWRAP_MANIFEST;
  if (table && manifest.length === 0) {
    throw AppError.badRequest(`Unknown re-wrap manifest table: ${table}`, 'TENANT_KEK_REWRAP_TABLE_INVALID');
  }

  const tables = [];
  let scanned = 0;
  let rewrapped = 0;
  for (const entry of manifest) {
    const result = await rewrapTable(tenantId, keyId, entry, dryRun);
    tables.push(result);
    scanned += result.scanned;
    rewrapped += result.rewrapped;
  }
  return {
    tenant_id: tenantId,
    key_id: keyId,
    dry_run: dryRun,
    scanned,
    rewrapped,
    tables,
  };
}

function serializeJob(job) {
  if (!job) return null;
  return {
    job_id: job.job_id,
    tenant_id: job.tenant_id,
    status: job.status,
    requested_by: job.requested_by,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    updated_at: job.updated_at,
    summary: job.summary,
    error: job.error,
  };
}

function runningJobForTenant(tenantId) {
  for (const job of JOBS.values()) {
    if (job.tenant_id === tenantId && !TERMINAL.has(job.status)) return job;
  }
  return null;
}

export function startTenantKekRewrapJob({ tenantId, requestedBy = null } = {}) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  const existing = runningJobForTenant(tenantId);
  if (existing) {
    throw AppError.conflict('A KEK re-wrap job is already running for this tenant', 'TENANT_KEK_REWRAP_ALREADY_RUNNING', {
      job_id: existing.job_id,
    });
  }

  const now = new Date().toISOString();
  const job = {
    job_id: crypto.randomUUID(),
    tenant_id: tenantId,
    requested_by: requestedBy,
    status: 'queued',
    created_at: now,
    started_at: null,
    completed_at: null,
    updated_at: now,
    summary: null,
    error: null,
  };
  JOBS.set(job.job_id, job);

  setImmediate(async () => {
    job.status = 'running';
    job.started_at = new Date().toISOString();
    job.updated_at = job.started_at;
    try {
      job.summary = await runTenantKekRewrap({ tenantId });
      job.status = 'succeeded';
      job.completed_at = new Date().toISOString();
      job.updated_at = job.completed_at;
    } catch (err) {
      job.status = 'failed';
      job.completed_at = new Date().toISOString();
      job.updated_at = job.completed_at;
      job.error = {
        code: err?.code || 'TENANT_KEK_REWRAP_FAILED',
        message: 'KEK re-wrap failed',
      };
      logger.error('Tenant KEK re-wrap job failed', {
        tenantId,
        jobId: job.job_id,
        error: err?.message,
      });
    }
  });

  return serializeJob(job);
}

export function getTenantKekRewrapJob({ tenantId, jobId } = {}) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  if (!jobId) throw AppError.badRequest('jobId is required', 'TENANT_KEK_REWRAP_JOB_ID_REQUIRED');
  const job = JOBS.get(jobId);
  if (!job || job.tenant_id !== tenantId) {
    throw AppError.notFound('KEK re-wrap job not found', 'TENANT_KEK_REWRAP_JOB_NOT_FOUND');
  }
  return serializeJob(job);
}

export function resetTenantKekRewrapJobsForTesting() {
  JOBS.clear();
}

export default {
  runTenantKekRewrap,
  startTenantKekRewrapJob,
  getTenantKekRewrapJob,
};
