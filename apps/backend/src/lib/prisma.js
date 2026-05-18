// src/lib/prisma.js — Singleton Prisma client + production hardening.
//
// This file is the single source of truth for DB access. 288+ call sites
// across src/ use `prisma.$queryRaw*` / `$executeRaw*` — all of them
// automatically pick up the hardening added here without any rewrite:
//
//   - Slow-query logging (>1000ms) in every env (prod + dev), not just dev.
//   - Circuit breaker: 5 consecutive failures → fail-fast for 30s, then
//     half-open on the next call. Mirrors the DatabaseManager semantics
//     from src/config/database.js so the two clients agree under load.
//   - `prismaReadOnly` — a second PrismaClient bound to DATABASE_READ_URL
//     for analytics / dashboards / exports. Falls back to primary when
//     DATABASE_READ_URL is unset (same contract as DatabaseManager.readPool).
//   - `setTenant(tenantId, fn, { superAdmin })` — wraps `fn(tx)` in a
//     $transaction with `SET LOCAL app.current_tenant_id = $1`, activating
//     the RLS policies installed by migration 075. `tx` is a Prisma client
//     you can call `$queryRaw`/`$executeRaw` on exactly like the top-level
//     prisma instance.
//
// Usage (unchanged for existing code):
//   import prisma from '../lib/prisma.js';
//   const rows = await prisma.$queryRaw`SELECT ... WHERE phone = ${phone}`;
//
// New capabilities:
//   import prisma, { prismaReadOnly, setTenant } from '../lib/prisma.js';
//
//   // Route analytics to read replica (falls back to primary if unset):
//   const stats = await prismaReadOnly.$queryRaw`SELECT ...`;
//
//   // Run a query under RLS tenant scoping (transaction-local GUC):
//   const rows = await setTenant(tenantId, (tx) =>
//     tx.$queryRaw`SELECT ... FROM appointments WHERE patient_id = ${id}`
//   );
//
//   // SUPER_ADMIN bypass (cross-tenant read):
//   await setTenant(null, (tx) => tx.$queryRaw`...`, { superAdmin: true });

import { PrismaClient } from '@prisma/client';
import logger from '../logging/logger.js';
import { getCurrentTenantContext, runInTenantContext } from './tenantContext.js';

// Phase-2 RLS enforcement. When AUTH_ENFORCE_TENANT_RLS=true and an
// AsyncLocalStorage tenant context is active (set per-request by
// tenantRlsMiddleware), every $queryRaw / $queryRawUnsafe /
// $executeRaw / $executeRawUnsafe call on this proxy is auto-wrapped in
// setTenant(tenantId, ...) so RLS policies (migration 075 + 236) actually
// fire. Flag off → legacy behaviour (permissive when GUC unset).
// Recursion is broken by the `inSetTenant: true` marker that setTenant
// adds to the context before invoking the callback.
const RAW_QUERY_METHODS = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
]);

function isRlsEnforcementEnabled() {
  return String(process.env.AUTH_ENFORCE_TENANT_RLS || '').toLowerCase() === 'true';
}

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 30_000;
const SLOW_QUERY_MS = 1000;

// Raw-SQL method names we wrap with the circuit breaker + error logging.
// $transaction is wrapped too so a failing transaction counts toward the
// failure budget — but NOTE: calls *inside* the transaction use a separate
// `tx` client that we also wrap (see setTenant below).
const WRAPPED_METHODS = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$transaction',
]);

// Postgres SQLSTATE codes that are NOT infrastructure failures and must
// not count toward the circuit breaker's consecutive-failure budget.
//
// The breaker exists to protect the connection pool from sustained infra
// outages (DB down, network partition, pool exhaustion). Schema-shape
// errors — "relation does not exist", "schema does not exist", etc. — are
// known-bad queries: the driver is healthy, the query just doesn't match
// the current schema. They occur in three real-world windows:
//
//   1. QA harness `DROP SCHEMA public CASCADE` during qa-reset (any
//      in-flight cron / health probe / request hits a partially-rebuilt
//      schema — see docs/qa-findings/2026-05-08-backend-circuit-breaker-
//      trips-during-qa-reset-schema-drop.md).
//   2. Planned production migrations that briefly DROP/RENAME a hot table.
//   3. Stale in-flight queries against a table that has been migrated away.
//
// Counting them latches the breaker open for 30s after the schema is
// already healthy, turning a brief migration window into a hard outage.
// Per-route handlers already deal with these via `err.meta.code === '42P01'`
// fallbacks (see routes/user/familyRoutes.js, controllers/investigation/*).
//
// SQLSTATE references: https://www.postgresql.org/docs/current/errcodes-appendix.html
const BREAKER_IGNORED_PG_ERROR_CODES = new Set([
  '42P01', // undefined_table — relation does not exist
  '42P02', // undefined_parameter
  '42703', // undefined_column
  '42704', // undefined_object (function, type, etc.)
  '3D000', // invalid_catalog_name — database does not exist
  '3F000', // invalid_schema_name — schema does not exist
]);

/**
 * Returns true if `err` is a Postgres known-bad-query error that the
 * circuit breaker should ignore (re-thrown to the caller, but not counted
 * as a failure). Pulls the SQLSTATE from the two places Prisma surfaces it:
 *   - PrismaClientKnownRequestError → err.meta.code (e.g. '42P01')
 *   - Wrapped-error fallback        → err.code (raw pg error)
 */
function isIgnoredBreakerError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err?.meta?.code || err?.code;
  return typeof code === 'string' && BREAKER_IGNORED_PG_ERROR_CODES.has(code);
}

let consecutiveFailures = 0;
let circuitOpen = false;
let circuitOpenedAt = null;

function makeClient(url, tag) {
  const client = new PrismaClient({
    datasources: { db: { url } },
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
      { level: 'query', emit: 'event' },
    ],
  });

  client.$on('warn', (e) => logger.warn(`Prisma[${tag}] warning`, { message: e?.message, target: e?.target }));
  client.$on('error', (e) => logger.error(`Prisma[${tag}] error`, { message: e?.message, target: e?.target, payload: e }));
  // Slow-query logging runs in EVERY env — ops need this signal in prod.
  client.$on('query', (e) => {
    if (e.duration > SLOW_QUERY_MS) {
      logger.warn(`Slow Prisma[${tag}] query`, {
        duration_ms: e.duration,
        query: String(e.query).substring(0, 200),
      });
    }
  });

  return client;
}

/**
 * Auto-wrap a raw-SQL call in setTenant when:
 *   - AUTH_ENFORCE_TENANT_RLS=true,
 *   - AsyncLocalStorage tenant context is active,
 *   - we're not already inside a setTenant transaction (recursion guard).
 *
 * When all three conditions hold, the call runs inside
 * `setTenant(ctx.tenantId, async (tx) => tx[methodName](...args))`
 * so migration 075/236's tenant_isolation policy fires. Otherwise the
 * call passes through to the underlying client — legacy behaviour
 * preserved exactly when the flag is off.
 */
async function maybeRunUnderTenant(baseClient, methodName, args) {
  if (!isRlsEnforcementEnabled()) return null;
  if (!RAW_QUERY_METHODS.has(methodName)) return null;
  const ctx = getCurrentTenantContext();
  if (!ctx || ctx.inSetTenant) return null;
  if (!ctx.tenantId && !ctx.superAdmin) return null;
  return runInTenantContext(ctx.tenantId, () => setTenant(
    ctx.tenantId,
    async (tx) => tx[methodName](...args),
    { superAdmin: ctx.superAdmin },
  ), { superAdmin: ctx.superAdmin });
}

/** Internal — wraps a Prisma raw-SQL method with circuit-breaker bookkeeping. */
function wrapWithCircuitBreaker(fn, methodName, tag) {
  return async function wrapped(...args) {
    if (circuitOpen) {
      const elapsed = Date.now() - circuitOpenedAt;
      if (elapsed < CIRCUIT_BREAKER_RESET_MS) {
        throw new Error('Database circuit breaker is open — service temporarily unavailable');
      }
      // Half-open: let one request through. Success → closes; failure → re-opens.
      circuitOpen = false;
      logger.info(`Prisma[${tag}] circuit breaker half-open — testing connection`);
    }
    try {
      // Phase-2 RLS: when the env flag + tenant context are both active,
      // route the call through setTenant so RLS policies actually fire.
      const tenantWrapped = await maybeRunUnderTenant(this, methodName, args);
      if (tenantWrapped !== null) {
        consecutiveFailures = 0;
        return tenantWrapped;
      }
      const result = await fn.apply(this, args);
      consecutiveFailures = 0;
      return result;
    } catch (err) {
      // Known-bad-query errors (relation/schema not found, undefined column,
      // etc.) are not infrastructure failures — the driver is healthy, the
      // query just doesn't match the current schema. Re-throw so the caller
      // can handle it, but don't count it toward the breaker budget.
      // Without this, a brief migration window or qa-reset DROP SCHEMA can
      // latch the breaker open for 30s after the schema is already healthy.
      if (isIgnoredBreakerError(err)) {
        throw err;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        circuitOpen = true;
        circuitOpenedAt = Date.now();
        logger.error(
          `Prisma[${tag}] circuit breaker OPEN after ${consecutiveFailures} consecutive failures`,
        );
      }
      throw err;
    }
  };
}

/**
 * Wrap the raw Prisma client in a Proxy that applies the circuit breaker
 * to WRAPPED_METHODS. Every other property passes through untouched, so
 * model APIs (`prisma.users.findUnique`, etc.), `$connect`, `$on`, and the
 * transaction `tx` client all behave exactly as before.
 */
function wrapClient(baseClient, tag) {
  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && WRAPPED_METHODS.has(prop)) {
        return wrapWithCircuitBreaker(value, prop, tag).bind(target);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const basePrimary = makeClient(process.env.DATABASE_URL, 'primary');
const prisma = wrapClient(basePrimary, 'primary');

// Separate client for analytics / dashboards. If DATABASE_READ_URL is unset,
// it re-uses the primary so callers always have a working client — same
// contract as DatabaseManager.readPool.
const baseReadOnly = process.env.DATABASE_READ_URL
  ? makeClient(process.env.DATABASE_READ_URL, 'readOnly')
  : basePrimary;
export const prismaReadOnly = process.env.DATABASE_READ_URL
  ? wrapClient(baseReadOnly, 'readOnly')
  : prisma;

/**
 * Execute `fn(tx)` inside a $transaction with tenant-scoped RLS active.
 * Sets `app.current_tenant_id` via `set_config(..., true)` so the GUC is
 * transaction-local (auto-cleared at COMMIT/ROLLBACK — no session-state
 * leak between pooled connections).
 *
 * The RLS policies installed by migration 075 recognize three cases:
 *   - GUC unset/empty  → permissive (legacy / non-tenant-aware code path)
 *   - GUC = 'bypass'   → full access (SUPER_ADMIN cross-tenant reads)
 *   - GUC = <uuid>     → only rows whose tenant_id matches the uuid
 *
 * Pass `{ superAdmin: true }` for cross-tenant admin reads; `tenantId` is
 * then ignored.
 *
 * Usage:
 *   const rows = await setTenant(req.user.tenantId, (tx) =>
 *     tx.$queryRaw`SELECT * FROM appointments WHERE patient_id = ${id}`
 *   );
 *
 * @param {string|null} tenantId UUID. Required unless superAdmin is true.
 * @param {(tx) => Promise<T>} fn Callback receiving the tenant-scoped client.
 * @param {Object} [options]
 * @param {boolean} [options.superAdmin=false]
 */
export async function setTenant(tenantId, fn, { superAdmin = false } = {}) {
  if (!superAdmin && !tenantId) {
    throw new Error('setTenant requires tenantId (or { superAdmin: true } to bypass)');
  }
  const gucValue = superAdmin ? 'bypass' : tenantId;

  // Mark the context so the auto-wrapper at the top of this file doesn't
  // re-wrap raw queries that already run inside this transaction (would
  // recurse and nest $transactions). Calls *outside* this fn (e.g. a
  // sibling promise after `await setTenant(...)`) see no inSetTenant flag
  // and behave normally.
  // Test-only escape hatch: when AUTH_TENANT_RLS_TEST_ROLE is set, SET LOCAL
  // ROLE to that role BEFORE the GUC. This is how the Phase-2 deep test
  // simulates production (which connects as a non-superuser, non-owner role).
  // CI Postgres and dev clusters often connect as a superuser/owner, which
  // bypasses RLS regardless of FORCE — without this hook the deep test
  // can only run on the local QA cluster's qa_writer role.
  const testRole = process.env.AUTH_TENANT_RLS_TEST_ROLE;

  return runInTenantContext(
    superAdmin ? null : tenantId,
    () => prisma.$transaction(async (tx) => {
      if (testRole) {
        // Identifier injection is gated to env config — never user input.
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${testRole}`);
      }
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        gucValue,
      );
      return fn(tx);
    }),
    { superAdmin, inSetTenant: true },
  );
}

/** Reset circuit-breaker state. Test-only. */
export function __resetCircuitBreakerForTests() {
  consecutiveFailures = 0;
  circuitOpen = false;
  circuitOpenedAt = null;
}

/** Current circuit-breaker status. Ops / health probes can read this. */
export function circuitBreakerStatus() {
  return {
    open: circuitOpen,
    consecutiveFailures,
    openedAt: circuitOpenedAt,
    resetInMs: circuitOpen && circuitOpenedAt
      ? Math.max(0, CIRCUIT_BREAKER_RESET_MS - (Date.now() - circuitOpenedAt))
      : 0,
  };
}

// Graceful shutdown. bin/www.js also handles SIGTERM/SIGINT separately; this
// fires on normal Node exit for good measure.
process.on('beforeExit', async () => {
  try { await basePrimary.$disconnect(); } catch { /* shutdown: ignore */ }
  if (baseReadOnly !== basePrimary) {
    try { await baseReadOnly.$disconnect(); } catch { /* shutdown: ignore */ }
  }
});

export default prisma;
