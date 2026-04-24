// src/config/database.js
//
// Thin pg-style shim over the hardened Prisma client (src/lib/prisma.js).
// Historically this module held its own pg pool; batches 23–28 consolidated
// every query path onto Prisma, so the pool is gone. The shim remains so
// the few remaining callers (RLS deep test, health probe, a couple of
// middleware pool-stat reporters) don't need bespoke migrations.
//
// Everything below delegates to the Prisma client(s) — circuit breaker,
// slow-query logging, RLS scoping, and read-replica routing all inherit
// automatically.

import prisma, { prismaReadOnly, setTenant } from '../lib/prisma.js';
import logger from '../logging/logger.js';

function returnsRows(sql) {
  return /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

async function runOn(client, sql, params = []) {
  if (returnsRows(sql)) {
    const rows = await client.$queryRawUnsafe(sql, ...params);
    return { rows: Array.isArray(rows) ? rows : [], rowCount: Array.isArray(rows) ? rows.length : 0 };
  }
  const rowCount = await client.$executeRawUnsafe(sql, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
}

class DatabaseManager {
  // Kept for back-compat — callers that import `db` treat it as "connected"
  // once Prisma's lazy-connect succeeds.
  constructor() {
    this.isConnected = true;
  }

  // No-op: Prisma connects lazily on first query. Existing callers that call
  // `connect()` at startup still work.
  async connect() {
    this.isConnected = true;
    return true;
  }

  /** Plain write query — circuit breaker + slow logs inherited from Prisma. */
  async query(text, params = []) {
    return runOn(prisma, text, params);
  }

  /** Read-only query — routes to DATABASE_READ_URL if configured, else primary. */
  async readQuery(text, params = []) {
    return runOn(prismaReadOnly, text, params);
  }

  /**
   * Tenant-scoped query — delegates to setTenant() from src/lib/prisma.js.
   * The Prisma $transaction sets `app.current_tenant_id` via
   * set_config(..., true) so the GUC is transaction-local.
   *
   * @param {string} text       Parameterized SQL ($1, $2, ...).
   * @param {Array}  params     Values for the placeholders.
   * @param {string|null} tenantId UUID of the tenant. Required unless superAdmin.
   * @param {Object} [options]
   * @param {boolean} [options.superAdmin=false]
   */
  async queryAsTenant(text, params = [], tenantId, { superAdmin = false } = {}) {
    return setTenant(
      tenantId,
      (tx) => runOn(tx, text, params),
      { superAdmin },
    );
  }

  /**
   * Health probe. `SELECT 1` proves Prisma + the underlying driver are live.
   * Pool-stat fields (writePool/readPool counts) are no longer reported
   * here — the legacy pg pool is gone and Prisma doesn't expose
   * `totalCount`/`idleCount` directly. Callers that want those metrics
   * should use `prisma.$metrics.json()` instead.
   */
  async healthCheck() {
    try {
      await prisma.$queryRaw`SELECT 1 AS ok`;
      return { healthy: true };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }

  /** Graceful shutdown — disconnects primary + replica Prisma clients. */
  async close() {
    try { await prisma.$disconnect(); } catch (err) { logger.warn('Prisma primary $disconnect failed', err); }
    if (prismaReadOnly !== prisma) {
      try { await prismaReadOnly.$disconnect(); } catch (err) { logger.warn('Prisma readOnly $disconnect failed', err); }
    }
    this.isConnected = false;
    logger.info('Database clients disconnected');
  }
}

// Removed in batch 28:
//   - pool / readPool (pg.Pool instances — replaced by Prisma's internal pool)
//   - getClient() (manual pg.Client — use prisma.$transaction instead)
// The two previous consumers (bedManagementService, rbacService) were
// migrated to prisma.$transaction in the same batch.

let instance = new DatabaseManager();

/** For testing: allows replacing the DB instance with a mock. */
export function setDatabaseInstance(mockDb) {
  instance = mockDb;
}

export function getDatabaseInstance() {
  return instance;
}

export default instance;
