// src/utils/tenantFanout.js
//
// W3 (multi-tenancy program) WS7 — per-tenant cron fan-out.
//
// Many scheduled jobs historically ran ONCE against the default tenant. This
// helper runs a job once PER active tenant (plus the default-tenant floor), each
// invocation inside runInTenantContext(tenantId, …) so the prisma proxy
// (maybeRunUnderTenant) auto-scopes the job's raw-SQL to that tenant when
// AUTH_ENFORCE_TENANT_RLS is enabled. At single-tenant (flag off, today) it loops
// over [default] only and the proxy passes through — behaviour-identical to the
// pre-fan-out cron. At the W7 multi-tenant cutover each tenant's data is processed
// in its own scope with no per-job changes.
//
// Fault isolation mirrors runAuditChainVerification: one tenant's throw (or a
// transient DB error) never aborts the others or crashes the scheduler tick.

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { runInTenantContext } from '../lib/tenantContext.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

/**
 * Run `perTenantFn(tenantId)` once for every active tenant (+ the default floor).
 *
 * @param {string} label  Job label for logs.
 * @param {(tenantId: string) => Promise<unknown>} perTenantFn
 * @param {Object} [options]
 * @param {boolean} [options.strict=false] fail when discovery or any tenant run fails
 * @returns {Promise<{ tenantsRun: number, errors: number }>}
 */
export async function runForEachTenant(label, perTenantFn, { strict = false } = {}) {
  let tenantIds = [DEFAULT_TENANT_ID];
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT id FROM tenants WHERE status = 'active'`);
    const ids = (Array.isArray(rows) ? rows : []).map((r) => r.id).filter(Boolean);
    tenantIds = [...new Set([DEFAULT_TENANT_ID, ...ids])];
  } catch (err) {
    if (strict) throw err;
    logger.warn(`${label}: tenant discovery failed, defaulting to platform tenant: ${err.message}`);
  }

  let tenantsRun = 0;
  let errors = 0;
  for (const tenantId of tenantIds) {
    try {
      await runInTenantContext(tenantId, () => perTenantFn(tenantId));
      tenantsRun += 1;
    } catch (err) {
      errors += 1;
      logger.error(`${label}: failed for tenant ${tenantId}: ${err.message}`, err);
    }
  }
  if (strict && errors > 0) {
    throw new Error(`${label}: ${errors} tenant run(s) failed`);
  }
  return { tenantsRun, errors };
}

export default { runForEachTenant };
