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
//   - `setTenant(tenantId, fn, { superAdmin, readOnly })` — wraps `fn(tx)` in a
//     $transaction with `SET LOCAL app.current_tenant_id = $1`, activating
//     the RLS policies installed by migration 075/304. `tx` is a Prisma client
//     you can call `$queryRaw`/`$executeRaw` on exactly like the top-level
//     prisma instance. `{ readOnly: true }` routes the tx to the read replica
//     when DATABASE_READ_URL is configured (primary otherwise).
//   - `setTenantTx(tenantId, fn, { superAdmin, readOnly })` — same mechanics,
//     the explicit primitive for code opening its OWN interactive transaction
//     for a multi-statement PHI/financial write that must be tenant-isolated.
//     A bare `prisma.$transaction(async (tx) => …)` is NOT tenant-scoped (the
//     GUC stays unset → policy falls through to its permissive branch).
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
import { PrismaPg } from '@prisma/adapter-pg';
import { isTenantRlsEnforcementEnabled } from '../config/tenantRlsConfig.js';
import logger from '../logging/logger.js';
import { extractSqlState } from '../services/security/schemaMissingGuard.js';
import { recordUndefinedTableFallback } from '../middleware/prometheusMiddleware.js';
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
  // Deterministic integrity rejections prove the database is reachable and
  // enforcing its contract. Counting user/data conflicts as infrastructure
  // failures lets five bad writes brown out every tenant on the client.
  '22P02', // invalid_text_representation (deterministic caller/query input)
  '23000', // integrity_constraint_violation
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23505', // unique_violation
  '23514', // check_violation
  '23P01', // exclusion_violation
  '42P01', // undefined_table — relation does not exist
  '42P02', // undefined_parameter
  '42703', // undefined_column
  '42704', // undefined_object (function, type, etc.)
  '3D000', // invalid_catalog_name — database does not exist
  '3F000', // invalid_schema_name — schema does not exist
]);

// Interactive transaction callbacks can reject for ordinary application
// control flow after the database has successfully opened the transaction.
// Only structured failures that mean the database/driver is unavailable are
// allowed to consume the global circuit-breaker budget from that callback.
const BREAKER_INFRA_PRISMA_ERROR_CODES = new Set([
  'P1000', // authentication failed
  'P1001', // database unreachable
  'P1002', // database reached but timed out
  'P1008', // operation timed out
  'P1010', // database access denied
  'P1011', // TLS connection failure
  'P1017', // server closed the connection
  'P1018', // transaction already closed
  'P2024', // connection-pool timeout
  'P2028', // transaction API timeout/state failure
  'P2036', // external connector failure
  'P2037', // too many database connections
]);

const BREAKER_INFRA_DRIVER_KINDS = new Set([
  'AuthenticationFailed',
  'DatabaseNotReachable',
  'SocketTimeout',
  'DatabaseAccessDenied',
  'TlsConnectionError',
  'ConnectionClosed',
  'TransactionAlreadyClosed',
  'GenericJs',
  'TooManyConnections',
]);

const BREAKER_INFRA_NODE_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

// node-postgres emits these connection failures without a machine-readable
// code. Keep the fallback exact so arbitrary business-error messages cannot
// be promoted to infrastructure failures.
const BREAKER_INFRA_ERROR_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'timeout expired',
]);

/**
 * Returns true if `err` is a Postgres known-bad-query error that the
 * circuit breaker should ignore (re-thrown to the caller, but not counted
 * as a failure). Pulls the SQLSTATE from the two places Prisma surfaces it:
 *   - PrismaClientKnownRequestError → err.meta.code (e.g. '42P01')
 *   - Prisma 7 driver adapter       → err.meta.driverAdapterError.cause.originalCode
 *   - Wrapped-error fallback        → err.code (raw pg error)
 */
function isIgnoredBreakerError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = extractSqlState(err);
  return typeof code === 'string' && BREAKER_IGNORED_PG_ERROR_CODES.has(code);
}

function isInfrastructureBreakerError(err) {
  if (!err || typeof err !== 'object') return false;

  if (BREAKER_INFRA_PRISMA_ERROR_CODES.has(err.code)) return true;
  if (BREAKER_INFRA_NODE_ERROR_CODES.has(err.code)) return true;

  const driverKind = err?.meta?.driverAdapterError?.cause?.kind || err?.cause?.kind;
  if (BREAKER_INFRA_DRIVER_KINDS.has(driverKind)) return true;

  const sqlState = extractSqlState(err);
  if (
    sqlState?.startsWith('08') || // connection_exception
    sqlState?.startsWith('53') || // insufficient_resources
    sqlState?.startsWith('58') || // system_error
    sqlState?.startsWith('XX') || // internal_error
    sqlState === '57014' || // query_canceled / statement timeout
    /^57P0[1-5]$/.test(sqlState || '') // operator intervention / idle timeout
  ) {
    return true;
  }

  return BREAKER_INFRA_ERROR_MESSAGES.has(String(err.message || '').trim());
}

class InteractiveTransactionCallbackFailure extends Error {
  constructor(cause) {
    super('Interactive transaction callback failed');
    this.cause = cause;
  }
}

function wrapInteractiveTransactionCallback(methodName, args) {
  if (methodName !== '$transaction' || typeof args[0] !== 'function') return args;

  const callback = args[0];
  const wrappedCallback = async function wrappedTransactionCallback(...callbackArgs) {
    try {
      return await callback.apply(this, callbackArgs);
    } catch (cause) {
      throw new InteractiveTransactionCallbackFailure(cause);
    }
  };
  return [wrappedCallback, ...args.slice(1)];
}

// M12 (audit 2026-06-22): circuit-breaker state is PER-CLIENT, keyed by the
// client tag ('primary' / 'readOnly'). Before this, the three counters were
// module-global and shared by BOTH the primary and the read-replica clients —
// so a read-replica outage incremented the same budget that gates primary
// queries and browned out the primary (and vice versa). Infra failures are
// global per CLIENT, NOT across clients; the meaningful fault-isolation
// boundary is primary vs replica. (Deliberately NOT per-tenant: the breaker
// already excludes query-shape errors via isIgnoredBreakerError, so it only
// ever counts true infrastructure failures, which are not tenant-specific.)
const breakers = new Map();

function getBreaker(tag) {
  let b = breakers.get(tag);
  if (!b) {
    b = { consecutiveFailures: 0, circuitOpen: false, circuitOpenedAt: null };
    breakers.set(tag, b);
  }
  return b;
}

/**
 * Append `?options=-c statement_timeout=<ms>` (URL-encoded) to a Postgres
 * connection URL so the app-layer statement_timeout fires before the CNPG
 * cluster default (60s). A value of 0 or a falsy string means "do not set" —
 * the cluster default governs. The option is idempotent: if the URL already
 * carries an `options` query param we append to it with a space (the format
 * Postgres libpq expects for multiple options).
 *
 * This is the standard approach for setting session-level GUCs via the
 * connection string; it is equivalent to `SET statement_timeout = <ms>` issued
 * immediately after connect but does not require an extra round-trip.
 *
 * MIGRATION SAFETY: runMigrations.js issues
 *   `SET LOCAL statement_timeout = '120s'` inside each migration transaction
 * which overrides the session-level default for that transaction only. The
 * app-layer 30s cap therefore does NOT apply to migration DDL.
 */
function applyStatementTimeoutToUrl(url, timeoutMs) {
  if (!url || !timeoutMs || timeoutMs <= 0) return url;
  try {
    const u = new URL(url);
    const existing = u.searchParams.get('options');
    const newOption = `-c statement_timeout=${timeoutMs}`;
    u.searchParams.set('options', existing ? `${existing} ${newOption}` : newOption);
    return u.toString();
  } catch {
    // Unparseable URL — return as-is and let Prisma surface the error.
    return url;
  }
}

// Pin every session's timezone so a `timestamptz` decodes to the same instant
// no matter how the server happens to be configured.
//
// The driver materialises a timestamptz as a JS Date in the DATABASE SESSION
// timezone, and that applies to BOTH `$queryRaw*` and the typed model
// delegates. On a non-UTC session `new Date(row.expires_at) < Date.now()` is
// therefore wrong by the session offset — which shipped as several real
// defects, two of them fail-open (expired credentials accepted) on a positive
// offset such as Asia/Kolkata. Prod and CI already run UTC, so this pin is a
// no-op there; what it buys is immunity to server config drift, and it makes
// dev/QA (whose cluster is Asia/Calcutta) decode instants exactly like prod.
//
// An explicit `timezone=` already present in the URL's `options` wins, so an
// operator retains a deliberate escape hatch.
export function pinSessionTimeZoneToUrl(url, timeZone = 'UTC') {
  if (!url) return url;
  try {
    const u = new URL(url);
    const existing = u.searchParams.get('options');
    if (existing && /(^|\s)-c\s*timezone=/i.test(existing)) return url;
    const pin = `-c timezone=${timeZone}`;
    u.searchParams.set('options', existing ? `${existing} ${pin}` : pin);
    return u.toString();
  } catch {
    // Unparseable URL — return as-is and let Prisma surface the error.
    return url;
  }
}

function makeClient(url, tag, { statementTimeoutMs = 0 } = {}) {
  if (!url) {
    throw new Error(`DATABASE_URL is required to create Prisma[${tag}] client`);
  }
  const connectionString = pinSessionTimeZoneToUrl(
    applyStatementTimeoutToUrl(url, statementTimeoutMs),
  );
  const adapter = new PrismaPg({ connectionString });
  const client = new PrismaClient({
    adapter,
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
  if (!isTenantRlsEnforcementEnabled()) return null;
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
    const breaker = getBreaker(tag);
    if (breaker.circuitOpen) {
      const elapsed = Date.now() - breaker.circuitOpenedAt;
      if (elapsed < CIRCUIT_BREAKER_RESET_MS) {
        throw new Error('Database circuit breaker is open — service temporarily unavailable');
      }
      // Half-open: let one request through. Success → closes; failure → re-opens.
      breaker.circuitOpen = false;
      logger.info(`Prisma[${tag}] circuit breaker half-open — testing connection`);
    }
    try {
      // Phase-2 RLS: when the env flag + tenant context are both active,
      // route the call through setTenant so RLS policies actually fire.
      const tenantWrapped = await maybeRunUnderTenant(this, methodName, args);
      if (tenantWrapped !== null) {
        breaker.consecutiveFailures = 0;
        return tenantWrapped;
      }
      const callArgs = wrapInteractiveTransactionCallback(methodName, args);
      const result = await fn.apply(this, callArgs);
      breaker.consecutiveFailures = 0;
      return result;
    } catch (err) {
      const callbackFailure = err instanceof InteractiveTransactionCallbackFailure;
      const breakerError = callbackFailure ? err.cause : err;
      // Known-bad-query errors (relation/schema not found, undefined column,
      // etc.) are not infrastructure failures — the driver is healthy, the
      // query just doesn't match the current schema. Re-throw so the caller
      // can handle it, but don't count it toward the breaker budget.
      // Without this, a brief migration window or qa-reset DROP SCHEMA can
      // latch the breaker open for 30s after the schema is already healthy.
      if (isIgnoredBreakerError(breakerError)) {
        // WS2 / REL-5: a Postgres 42P01 (undefined_table) specifically means a
        // graceful fallback path is being exercised (missing-table read during a
        // migration window, a partition the downtime mirror papers over, etc.).
        // Scope this to EXACTLY 42P01 — NOT the whole ignored set (42703 column,
        // 3F000 schema, … are different signals) — so the named metric + warn
        // track only the undefined_table fallback. Reuse extractSqlState rather
        // than re-deriving the SQLSTATE. The error is still re-thrown unchanged.
        if (extractSqlState(breakerError) === '42P01') {
          recordUndefinedTableFallback();
          logger.warn('Postgres 42P01 (undefined_table) — graceful fallback path', {
            message: String(breakerError?.message || '').slice(0, 200),
          });
        }
        breaker.consecutiveFailures = 0;
        throw breakerError;
      }
      if (callbackFailure && !isInfrastructureBreakerError(breakerError)) {
        breaker.consecutiveFailures = 0;
        throw breakerError;
      }
      breaker.consecutiveFailures += 1;
      if (breaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        breaker.circuitOpen = true;
        breaker.circuitOpenedAt = Date.now();
        logger.error(
          `Prisma[${tag}] circuit breaker OPEN after ${breaker.consecutiveFailures} consecutive failures`,
        );
      }
      throw breakerError;
    }
  };
}

/**
 * Tenant-scope a Prisma MODEL-API call (roadmap A2). The Phase-2 auto-wrapper
 * originally covered only $queryRaw* / $executeRaw* — but the typed-ORM
 * migrations (batches 26–38) moved many domains to the model API
 * (`prisma.appointments.findMany(...)`), which connected with the GUC unset
 * and therefore hit the PERMISSIVE branch of every tenant_isolation policy.
 * The tenant-rls-http deep test demonstrated the resulting cross-tenant PHI
 * read through GET /api/v1/appointments/list. This wrapper routes model calls
 * through setTenant exactly like raw calls.
 *
 * KNOWN LIMITATIONS (documented, lint-guarded where possible):
 *   * Array-form `prisma.$transaction([...])` requires lazy PrismaPromises.
 *     Under an active tenant context the wrapped methods return real
 *     Promises, which Prisma rejects LOUDLY (not silently): convert such
 *     sites to the interactive form. All four pre-existing sites
 *     (billingService ×3, medicationService ×1) were converted with this
 *     change.
 *   * Interactive `prisma.$transaction(async (tx) => ...)` callbacks receive
 *     the raw tx client — model/raw calls inside are NOT auto-scoped (you
 *     cannot nest a transaction inside a transaction). Those sites keep
 *     legacy permissive behaviour until they adopt setTenant explicitly —
 *     the Phase-2 call-site audit continues to track them.
 */
const MODEL_DELEGATE_CACHE = new WeakMap(); // baseClient → Map<prop, proxy>
// Capability brand for callbacks opened by setTenant/setTenantTx. Pathway
// mutation primitives use this identity check so the global singleton or a
// bare, unscoped Prisma interactive transaction cannot impersonate the
// tenant-scoped atomic boundary they require.
const TENANT_TRANSACTION_CLIENTS = new WeakSet();

function isModelDelegate(value, prop) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof prop === 'string' &&
    !prop.startsWith('$') &&
    !prop.startsWith('_') &&
    typeof value.findMany === 'function'
  );
}

function shouldTenantWrap() {
  if (!isTenantRlsEnforcementEnabled()) return null;
  const ctx = getCurrentTenantContext();
  if (!ctx || ctx.inSetTenant) return null;
  if (!ctx.tenantId && !ctx.superAdmin) return null;
  return ctx;
}

function wrapModelDelegate(baseClient, delegate, modelProp) {
  let perClient = MODEL_DELEGATE_CACHE.get(baseClient);
  if (!perClient) {
    perClient = new Map();
    MODEL_DELEGATE_CACHE.set(baseClient, perClient);
  }
  if (perClient.has(modelProp)) return perClient.get(modelProp);

  const proxied = new Proxy(delegate, {
    get(target, method, receiver) {
      const fn = Reflect.get(target, method, receiver);
      if (typeof fn !== 'function' || typeof method !== 'string' || method.startsWith('$')) {
        return typeof fn === 'function' ? fn.bind(target) : fn;
      }
      return function tenantAwareModelCall(...args) {
        const ctx = shouldTenantWrap();
        if (!ctx) return fn.apply(target, args);
        // Run the model call inside a setTenant transaction so the GUC (and
        // the runtime role, when configured) applies. tx[modelProp] is the
        // transaction-scoped delegate for the same model.
        return runInTenantContext(ctx.tenantId, () => setTenant(
          ctx.tenantId,
          async (tx) => tx[modelProp][method](...args),
          { superAdmin: ctx.superAdmin },
        ), { superAdmin: ctx.superAdmin });
      };
    },
  });
  perClient.set(modelProp, proxied);
  return proxied;
}

/**
 * Wrap the raw Prisma client in a Proxy that applies the circuit breaker
 * to WRAPPED_METHODS and tenant scoping to BOTH raw-SQL methods and model
 * delegates. `$connect`, `$on`, and the transaction `tx` client behave
 * exactly as before.
 */
function wrapClient(baseClient, tag) {
  return new Proxy(baseClient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function' && WRAPPED_METHODS.has(prop)) {
        return wrapWithCircuitBreaker(value, prop, tag).bind(target);
      }
      if (isModelDelegate(value, prop)) {
        return wrapModelDelegate(target, value, prop);
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// App-layer statement_timeout (DB-2 / B2.8).
//
// STATEMENT_TIMEOUT_MS sets a session-level Postgres statement_timeout on the
// PRIMARY connection so runaway app queries are killed at 30s (default) rather
// than relying solely on the CNPG cluster cap (60s). This protects the
// connection pool from slow queries that would otherwise hold a slot until the
// cluster-level cap fires.
//
// Why the primary only (not the read replica):
//   Analytics / export queries on the read replica can legitimately run longer
//   than 30s (complex aggregations, large exports). Imposing the same cap there
//   would cause false positives. Read-replica queries are still bounded by the
//   CNPG cluster default (60s) and the circuit breaker. To add a separate read
//   cap, set STATEMENT_TIMEOUT_READ_MS (0 = use cluster default).
//
// Migration safety: runMigrations.js issues
//   `SET LOCAL statement_timeout = '120s'` inside each migration $transaction
// which overrides the session default for that transaction. The 30s app-layer
// cap does NOT affect DDL migrations.
const PRIMARY_STATEMENT_TIMEOUT_MS = parseInt(process.env.STATEMENT_TIMEOUT_MS || '30000', 10);
// 0 = leave at cluster default (no override appended to the read URL)
const READ_STATEMENT_TIMEOUT_MS = parseInt(process.env.STATEMENT_TIMEOUT_READ_MS || '0', 10);

const basePrimary = makeClient(
  process.env.DATABASE_URL,
  'primary',
  { statementTimeoutMs: PRIMARY_STATEMENT_TIMEOUT_MS },
);
const prisma = wrapClient(basePrimary, 'primary');

// Separate client for analytics / dashboards. If DATABASE_READ_URL is unset,
// it re-uses the primary so callers always have a working client — same
// contract as DatabaseManager.readPool.
const baseReadOnly = process.env.DATABASE_READ_URL
  ? makeClient(
    process.env.DATABASE_READ_URL,
    'readOnly',
    { statementTimeoutMs: READ_STATEMENT_TIMEOUT_MS },
  )
  : basePrimary;
export const prismaReadOnly = process.env.DATABASE_READ_URL
  ? wrapClient(baseReadOnly, 'readOnly')
  : prisma;

/**
 * Pick the client a tenant-scoped transaction should open on. Read-only /
 * analytics paths route to the read replica when one is configured
 * (`DATABASE_READ_URL` set → `prismaReadOnly` is a *distinct* wrapped client);
 * everything else runs on the primary. When no replica is configured
 * `prismaReadOnly === prisma`, so `readOnly` is a no-op and behaviour is
 * unchanged — preserving the current single-DB contract exactly.
 *
 * NOTE: both returned clients are the circuit-breaker-wrapped proxies, so the
 * breaker bookkeeping still fires for the outer `$transaction`. The
 * `inSetTenant` context marker (set by the caller) stops the proxy's raw-query
 * auto-wrapper from re-wrapping queries that already run inside this tx.
 */
function pickTenantClient({ readOnly = false } = {}) {
  return readOnly ? prismaReadOnly : prisma;
}

/**
 * Internal: open a `$transaction` on `client`, install the tenant-scoping
 * preamble (SET LOCAL ROLE when a runtime role is configured, then
 * `set_config('app.current_tenant_id', …, true)`) as the FIRST statements, and
 * run `fn(tx)` so every query in the callback is RLS-scoped to `gucValue`.
 *
 * The GUC is transaction-local (`set_config(…, true)` — auto-cleared at
 * COMMIT/ROLLBACK, no session-state leak between pooled connections), exactly
 * mirroring the original setTenant mechanics. Shared by setTenant() and
 * setTenantTx() so both use one audited GUC/role code path.
 *
 * Runtime-role escape hatch: when AUTH_TENANT_RLS_RUNTIME_ROLE (canonical,
 * prod-facing name — see roadmap item A2) or AUTH_TENANT_RLS_TEST_ROLE
 * (legacy alias kept for existing rigs/tests) is set, SET LOCAL ROLE to that
 * role BEFORE the GUC. Two deployment shapes need it:
 *   * dalekdefender / CI: connection role is a SUPERUSER → bypasses RLS even
 *     under FORCE; the non-bypass role restores enforcement.
 *   * CNPG prod: connection role OWNS the tables; FORCE (migrations
 *     237/238/239/272/304) covers owned tables, and the runtime role is
 *     belt-and-braces for any future unforced table.
 */
function runTenantScopedTransaction(
  client,
  gucValue,
  fn,
  transactionOptions = undefined,
) {
  const testRole = tenantRlsRuntimeRole();
  const transaction = async (tx) => {
    if (testRole) {
      // Identifier injection is gated to env config — never user input.
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${testRole}`);
    }
    await tx.$queryRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      gucValue,
    );
    TENANT_TRANSACTION_CLIENTS.add(tx);
    return fn(tx);
  };
  return transactionOptions
    ? client.$transaction(transaction, transactionOptions)
    : client.$transaction(transaction);
}

export function isTenantTransactionClient(value) {
  return Boolean(
    value
    && (typeof value === 'object' || typeof value === 'function')
    && TENANT_TRANSACTION_CLIENTS.has(value)
  );
}

/**
 * Open a tenant-scoped INTERACTIVE transaction and run `fn(tx)` with RLS
 * enforcement active for every query inside it.
 *
 * This is the primitive for code that needs to open its OWN interactive
 * transaction (multi-statement atomic writes, FOR UPDATE locks, etc.) AND
 * have it tenant-isolated. A bare `prisma.$transaction(async (tx) => …)` is
 * NOT tenant-scoped: the `tx` client it hands you skips the prisma proxy's
 * auto-wrapper, so the `app.current_tenant_id` GUC stays unset and migration
 * 075/304's tenant_isolation policy falls through to its PERMISSIVE branch —
 * i.e. cross-tenant rows are reachable inside that tx. `setTenantTx` issues
 * `set_config('app.current_tenant_id', …, true)` (and SET LOCAL ROLE when a
 * runtime role is configured) as the FIRST statements of the transaction, so
 * the policy's strict branch (`tenant_id = app_current_tenant_id_uuid()`)
 * applies to every subsequent query and WITH CHECK on every write.
 *
 * Mechanics are identical to setTenant() (shared code path); the difference is
 * intent + naming: reach for setTenantTx at a call site that previously used a
 * raw `prisma.$transaction` for a multi-step PHI/financial mutation.
 *
 * The RLS policies recognize three GUC cases:
 *   - GUC unset/empty  → permissive (legacy / non-tenant-aware code path)
 *   - GUC = 'bypass'   → full access (SUPER_ADMIN cross-tenant reads)
 *   - GUC = <uuid>     → only rows whose tenant_id matches the uuid
 *
 * @param {string|null} tenantId UUID. Required unless superAdmin is true.
 * @param {(tx) => Promise<T>} fn Callback receiving the tenant-scoped client.
 * @param {Object} [options]
 * @param {boolean} [options.superAdmin=false] set GUC to 'bypass' (cross-tenant).
 * @param {boolean} [options.readOnly=false] route to the read replica when
 *   DATABASE_READ_URL is configured; primary otherwise (no-op when unset).
 * @param {string} [options.isolationLevel] Prisma transaction isolation level.
 * @param {number} [options.maxWait] maximum milliseconds to acquire a transaction.
 * @param {number} [options.timeout] maximum milliseconds for the interactive transaction.
 */
export async function setTenantTx(
  tenantId,
  fn,
  {
    superAdmin = false,
    readOnly = false,
    isolationLevel = undefined,
    maxWait = undefined,
    timeout = undefined,
  } = {},
) {
  if (!superAdmin && !tenantId) {
    throw new Error('setTenantTx requires tenantId (or { superAdmin: true } to bypass)');
  }
  const gucValue = superAdmin ? 'bypass' : tenantId;
  const client = pickTenantClient({ readOnly });
  const transactionOptions = {
    ...(isolationLevel ? { isolationLevel } : {}),
    ...(maxWait == null ? {} : { maxWait }),
    ...(timeout == null ? {} : { timeout }),
  };

  // Mark the context so the prisma proxy's auto-wrapper does NOT re-wrap raw
  // queries that already run inside this transaction (would recurse and nest
  // $transactions). Calls *outside* this fn (e.g. a sibling promise after
  // `await setTenantTx(...)`) see no inSetTenant flag and behave normally.
  return runInTenantContext(
    superAdmin ? null : tenantId,
    () => runTenantScopedTransaction(
      client,
      gucValue,
      fn,
      Object.keys(transactionOptions).length > 0 ? transactionOptions : undefined,
    ),
    { superAdmin, inSetTenant: true },
  );
}

/**
 * Execute `fn(tx)` inside a $transaction with tenant-scoped RLS active.
 * Sets `app.current_tenant_id` via `set_config(..., true)` so the GUC is
 * transaction-local (auto-cleared at COMMIT/ROLLBACK — no session-state
 * leak between pooled connections).
 *
 * Thin wrapper over setTenantTx() — kept as the canonical name used by the
 * 288+ existing call sites + the prisma proxy auto-wrapper. New code that is
 * converting a raw `prisma.$transaction` PHI/financial write should call
 * setTenantTx() directly (identical behaviour, clearer intent).
 *
 * The RLS policies installed by migration 075 recognize three cases:
 *   - GUC unset/empty  → permissive (legacy / non-tenant-aware code path)
 *   - GUC = 'bypass'   → full access (SUPER_ADMIN cross-tenant reads)
 *   - GUC = <uuid>     → only rows whose tenant_id matches the uuid
 *
 * Pass `{ superAdmin: true }` for cross-tenant admin reads; `tenantId` is
 * then ignored. Pass `{ readOnly: true }` to route to the read replica when
 * DATABASE_READ_URL is configured (primary otherwise).
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
 * @param {boolean} [options.readOnly=false]
 */
export async function setTenant(tenantId, fn, { superAdmin = false, readOnly = false } = {}) {
  if (!superAdmin && !tenantId) {
    throw new Error('setTenant requires tenantId (or { superAdmin: true } to bypass)');
  }
  return setTenantTx(tenantId, fn, { superAdmin, readOnly });
}

/** Reset circuit-breaker state. Test-only. */
export function __resetCircuitBreakerForTests() {
  breakers.clear();
}

/**
 * Current circuit-breaker status. Ops / health probes can read this.
 *
 * Top-level fields are the AGGREGATE across all clients (back-compat: `open`
 * = ANY client breaker open; `consecutiveFailures` = the worst client;
 * `openedAt`/`resetInMs` = the longest-remaining open client). `byTag` exposes
 * the per-client breakdown (primary vs readOnly) so /health/metrics and the
 * self-healing middleware can see which client is degraded, not just "something
 * is" — the observability half of M12.
 */
export function circuitBreakerStatus() {
  const byTag = {};
  let anyOpen = false;
  let worstFailures = 0;
  let earliestOpenedAt = null;
  let maxResetInMs = 0;
  for (const [tag, b] of breakers) {
    const resetInMs = b.circuitOpen && b.circuitOpenedAt
      ? Math.max(0, CIRCUIT_BREAKER_RESET_MS - (Date.now() - b.circuitOpenedAt))
      : 0;
    byTag[tag] = {
      open: b.circuitOpen,
      consecutiveFailures: b.consecutiveFailures,
      openedAt: b.circuitOpenedAt,
      resetInMs,
    };
    if (b.circuitOpen) {
      anyOpen = true;
      if (earliestOpenedAt === null || (b.circuitOpenedAt && b.circuitOpenedAt < earliestOpenedAt)) {
        earliestOpenedAt = b.circuitOpenedAt;
      }
      if (resetInMs > maxResetInMs) maxResetInMs = resetInMs;
    }
    if (b.consecutiveFailures > worstFailures) worstFailures = b.consecutiveFailures;
  }
  return {
    open: anyOpen,
    consecutiveFailures: worstFailures,
    openedAt: earliestOpenedAt,
    resetInMs: maxResetInMs,
    byTag,
  };
}

/**
 * The SET LOCAL ROLE target for tenant-scoped transactions.
 * AUTH_TENANT_RLS_RUNTIME_ROLE is the canonical name; AUTH_TENANT_RLS_TEST_ROLE
 * is the legacy alias (pre-roadmap-A2 rigs and the Phase-2 deep tests).
 */
export function tenantRlsRuntimeRole(env = process.env) {
  const role = env.AUTH_TENANT_RLS_RUNTIME_ROLE || env.AUTH_TENANT_RLS_TEST_ROLE;
  const trimmed = typeof role === 'string' ? role.trim() : '';
  return trimmed || null;
}

/**
 * Pure verdict for whether tenant RLS will actually be enforced, given the
 * connection role and the optional SET LOCAL ROLE override
 * (AUTH_TENANT_RLS_RUNTIME_ROLE / legacy AUTH_TENANT_RLS_TEST_ROLE).
 * No DB access — unit-testable in isolation.
 *
 * Postgres bypasses ALL row-level security for roles with `rolsuper` or
 * `rolbypassrls`, *even under FORCE ROW LEVEL SECURITY*. So if enforcement
 * is on (AUTH_ENFORCE_TENANT_RLS=true) but the *effective* role — the
 * SET LOCAL ROLE target when AUTH_TENANT_RLS_TEST_ROLE is set, else the
 * connection role — bypasses RLS, every tenant_isolation policy (migrations
 * 075/236/237) is silently inert. This is the gap behind swarm finding
 * 2026-05-17-cross-tenant-rls-receptionist-2242cd96 (a bootstrap superuser
 * connection makes the Phase-2 cutover a no-op despite the flag being on).
 *
 * Read-replica posture (SEC-3): when DATABASE_READ_URL is configured,
 * setTenant/setTenantTx route `readOnly` tenant transactions to the replica
 * client. SET LOCAL ROLE applies there too, but if the replica's effective
 * role (its runtime role, else its connection role) has SUPERUSER/BYPASSRLS,
 * every tenant-scoped READ on the replica silently bypasses RLS — the same
 * inert-isolation failure as the primary, on a path the primary probe never
 * sees. Pass `replicaProbed` + the replica's role facts to fold that into the
 * verdict; omit them (default) on single-DB deployments and the replica
 * branch is skipped entirely.
 *
 * @returns {{enforced:boolean, ok:boolean, effectiveRole:string|null,
 *            bypassesRls:boolean, reason:string}}
 */
export function evaluateTenantRlsPosture(input = {}) {
  const verdict = evaluateTenantRlsPostureCore(input);
  // The runtime role (SET LOCAL ROLE inside setTenant/setTenantTx) is the
  // effective role for tenant-scoped work ONLY. Everything outside those
  // transactions — the pre-auth writers under /api/v1/auth in particular —
  // runs as the bare CONNECTION role, so the verdict also reports that
  // role's own RLS status: when it is subject to RLS, an unscoped write to a
  // FORCE-RLS table carrying a RESTRICTIVE policy (migration 758's
  // explicit_tenant_context_753 on users) is rejected 42501. A verdict keyed
  // only on `testRole || connectionRole` was structurally blind to that path
  // and reported "posture OK" on a cluster where first-time registration
  // failed every time.
  const enforced = Boolean(input.enforced);
  const connectionBypassesRls = Boolean(input.connectionBypassesRls);
  return {
    ...verdict,
    connectionRole: input.connectionRole ?? null,
    connectionBypassesRls,
    connectionRoleRlsSubject: enforced && !connectionBypassesRls,
    restrictiveForcedTables: Number(input.restrictiveForcedTables) || 0,
  };
}

function evaluateTenantRlsPostureCore({
  enforced,
  connectionRole = null,
  connectionBypassesRls = false,
  testRole = null,
  testRoleBypassesRls = false,
  effectiveRoleOwnsUnforcedRlsTables = 0,
  replicaProbed = false,
  replicaConnectionRole = null,
  replicaConnectionBypassesRls = false,
  replicaTestRoleBypassesRls = false,
} = {}) {
  if (!enforced) {
    return {
      enforced: false,
      ok: true,
      effectiveRole: connectionRole,
      bypassesRls: connectionBypassesRls,
      unforcedOwnedRlsTables: effectiveRoleOwnsUnforcedRlsTables,
      reason: 'enforcement_disabled',
    };
  }
  const effectiveRole = testRole || connectionRole;
  const bypassesRls = testRole ? testRoleBypassesRls : connectionBypassesRls;
  // Replica's effective role: SET LOCAL ROLE (the same runtime role) applies on
  // the replica too, so the same test-role-vs-connection-role precedence holds.
  const replicaEffectiveRole = replicaProbed ? (testRole || replicaConnectionRole) : null;
  const replicaBypassesRls = replicaProbed
    ? (testRole ? replicaTestRoleBypassesRls : replicaConnectionBypassesRls)
    : false;
  if (bypassesRls) {
    return {
      enforced: true,
      ok: false,
      effectiveRole,
      bypassesRls,
      unforcedOwnedRlsTables: effectiveRoleOwnsUnforcedRlsTables,
      replicaEffectiveRole,
      replicaBypassesRls,
      reason: 'effective_role_bypasses_rls',
    };
  }
  // Owner-exemption gap: Postgres exempts a table's OWNER from RLS unless the
  // table has FORCE ROW LEVEL SECURITY. CNPG prod connects as the bootstrap
  // owner (`vhhealth`), which is neither SUPERUSER nor BYPASSRLS — the
  // rolsuper/rolbypassrls check above passes, yet every tenant_isolation
  // policy on an unforced owned table is still inert. Migration 272 forces
  // the known set; this verdict alarms if any table regresses.
  if (effectiveRoleOwnsUnforcedRlsTables > 0) {
    return {
      enforced: true,
      ok: false,
      effectiveRole,
      bypassesRls: false,
      unforcedOwnedRlsTables: effectiveRoleOwnsUnforcedRlsTables,
      replicaEffectiveRole,
      replicaBypassesRls,
      reason: 'owner_exempt_unforced_tables',
    };
  }
  // Replica role bypasses RLS — tenant-scoped reads routed to the replica
  // (setTenant/setTenantTx { readOnly:true }) leak cross-tenant even though the
  // primary is sound. Only reachable when a distinct replica was probed.
  if (replicaProbed && replicaBypassesRls) {
    return {
      enforced: true,
      ok: false,
      effectiveRole,
      bypassesRls: false,
      unforcedOwnedRlsTables: 0,
      replicaEffectiveRole,
      replicaBypassesRls: true,
      reason: 'replica_role_bypasses_rls',
    };
  }
  return {
    enforced: true,
    ok: true,
    effectiveRole,
    bypassesRls: false,
    unforcedOwnedRlsTables: 0,
    replicaEffectiveRole,
    replicaBypassesRls: false,
    reason: 'enforced',
  };
}

/**
 * Probe the live database for the tenant-RLS role posture. Uses
 * `session_user` (the authenticated connection identity, unaffected by any
 * SET ROLE) so the verdict is correct even if this runs inside a setTenant
 * transaction. Best-effort: returns an `{ error }` shape if the probe fails;
 * never throws.
 */
export async function tenantRlsRolePosture() {
  const enforced = isTenantRlsEnforcementEnabled();
  const testRole = tenantRlsRuntimeRole();
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         session_user AS connection_role,
         COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = session_user), false) AS connection_bypasses_rls,
         CASE WHEN NULLIF($1, '') IS NOT NULL
              THEN COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = NULLIF($1, '')), true)
              ELSE false END AS test_role_bypasses_rls,
         (SELECT count(*)::int
            FROM pg_policies p
            JOIN pg_class c     ON c.relname = p.tablename
            JOIN pg_namespace n ON n.oid = c.relnamespace
                               AND n.nspname = p.schemaname
           WHERE p.schemaname = 'public'
             AND p.policyname = 'tenant_isolation'
             AND c.relrowsecurity
             AND NOT c.relforcerowsecurity
             AND c.relowner = (
               SELECT oid FROM pg_roles
                WHERE rolname = COALESCE(NULLIF($1, ''), session_user)
             )) AS unforced_owned_rls_tables,
         (SELECT count(DISTINCT c.oid)::int
            FROM pg_policies p
            JOIN pg_class c     ON c.relname = p.tablename
            JOIN pg_namespace n ON n.oid = c.relnamespace
                               AND n.nspname = p.schemaname
           WHERE p.schemaname = 'public'
             AND p.permissive = 'RESTRICTIVE'
             AND c.relforcerowsecurity) AS restrictive_forced_tables`,
      testRole || '',
    );
    const row = rows?.[0] || {};

    // SEC-3 — when a distinct read replica is configured, probe ITS role too:
    // setTenant/setTenantTx { readOnly:true } route tenant-scoped reads there,
    // so a SUPERUSER/BYPASSRLS replica role is just as inert as on the primary.
    // Best-effort: a failed replica probe must not corrupt the primary verdict.
    let replicaProbed = false;
    let replicaRow = {};
    if (prismaReadOnly !== prisma) {
      try {
        const replicaRows = await prismaReadOnly.$queryRawUnsafe(
          `SELECT
             session_user AS connection_role,
             COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = session_user), false) AS connection_bypasses_rls,
             CASE WHEN NULLIF($1, '') IS NOT NULL
                  THEN COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = NULLIF($1, '')), true)
                  ELSE false END AS test_role_bypasses_rls`,
          testRole || '',
        );
        replicaRow = replicaRows?.[0] || {};
        replicaProbed = true;
      } catch (replicaErr) {
        logger.warn('Tenant RLS replica posture probe failed (primary verdict unaffected)', {
          message: replicaErr?.message,
        });
      }
    }

    return {
      ...evaluateTenantRlsPosture({
        enforced,
        connectionRole: row.connection_role ?? null,
        connectionBypassesRls: row.connection_bypasses_rls === true,
        testRole,
        testRoleBypassesRls: row.test_role_bypasses_rls === true,
        effectiveRoleOwnsUnforcedRlsTables: Number(row.unforced_owned_rls_tables) || 0,
        restrictiveForcedTables: Number(row.restrictive_forced_tables) || 0,
        replicaProbed,
        replicaConnectionRole: replicaRow.connection_role ?? null,
        replicaConnectionBypassesRls: replicaRow.connection_bypasses_rls === true,
        replicaTestRoleBypassesRls: replicaRow.test_role_bypasses_rls === true,
      }),
      connectionRole: row.connection_role ?? null,
      replicaConnectionRole: replicaProbed ? (replicaRow.connection_role ?? null) : null,
      replicaProbed,
      testRole,
      runtimeRole: testRole,
    };
  } catch (err) {
    return {
      enforced,
      ok: null,
      effectiveRole: testRole,
      testRole,
      error: 'rls_posture_probe_failed',
      reason: 'probe_error',
      message: err?.message,
    };
  }
}

// Pure: how loudly to surface a *disabled* tenant-RLS posture at boot. In
// production a disabled posture is a multi-tenant PHI-isolation gap → 'warn';
// elsewhere (dev/test, or a confirmed single-tenant install) it's expected →
// 'info'. Exported for unit testing.
export function rlsDisabledLogLevel(nodeEnv = process.env.NODE_ENV) {
  return String(nodeEnv || '').toLowerCase() === 'production' ? 'warn' : 'info';
}

/**
 * Boot-time guard: log the tenant-RLS role posture. Emits a loud ERROR when
 * enforcement is on but the effective role bypasses RLS (policies inert), and
 * a loud WARNING when enforcement is off in production (policies inert), so
 * a misconfigured deployment can't silently ship inert isolation. Boot callers
 * may request bounded retries; the returned error posture is then handled by
 * tenantRlsPostureMustFailClosed rather than being mistaken for safety.
 */
export async function logTenantRlsRolePosture({
  attempts = 1,
  delayMs = 0,
  probe = tenantRlsRolePosture,
} = {}) {
  const boundedAttempts = Math.max(1, Math.min(5, Number.parseInt(attempts, 10) || 1));
  let posture;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    posture = await probe();
    if (!posture?.error) break;
    if (attempt < boundedAttempts && delayMs > 0) {
      logger.warn('Tenant RLS posture probe failed; retrying before startup', {
        reason: posture.reason,
        attempt,
        attempts: boundedAttempts,
      });
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  if (posture.error) {
    logger.warn('Tenant RLS posture probe failed', { reason: posture.reason });
    return posture;
  }
  if (!posture.enforced) {
    // In production a disabled RLS posture means tenant_isolation policies are
    // inert and cross-tenant reads/writes are not blocked at the DB layer — a
    // PHI-isolation gap for any multi-tenant deployment. Surface it loudly so a
    // misconfigured prod can't ship silently. Outside production (dev/test, or a
    // confirmed single-tenant install) RLS-off is expected → info.
    if (rlsDisabledLogLevel() === 'warn') {
      logger.warn(
        'TENANT RLS ENFORCEMENT IS OFF in production (AUTH_ENFORCE_TENANT_RLS != true) — '
        + 'tenant_isolation policies are inert; cross-tenant reads/writes are NOT blocked at the '
        + 'DB layer. Required for any multi-tenant deployment: set AUTH_ENFORCE_TENANT_RLS=true and '
        + 'connect as a non-superuser, non-BYPASSRLS role. Ignore ONLY for a confirmed single-tenant install.',
        { effectiveRole: posture.effectiveRole },
      );
    } else {
      logger.info('Tenant RLS enforcement disabled (AUTH_ENFORCE_TENANT_RLS != true)', {
        effectiveRole: posture.effectiveRole,
      });
    }
    return posture;
  }
  if (!posture.ok) {
    if (posture.reason === 'owner_exempt_unforced_tables') {
      logger.error(
        'TENANT RLS IS PARTIALLY INERT: AUTH_ENFORCE_TENANT_RLS=true but the effective DB role ' +
          `'${posture.effectiveRole}' OWNS ${posture.unforcedOwnedRlsTables} table(s) carrying a ` +
          'tenant_isolation policy without FORCE ROW LEVEL SECURITY — Postgres exempts table ' +
          'owners from non-forced RLS, so isolation on those tables is silently bypassed. ' +
          'Run migration 272 (forces all tenant_isolation tables) or set ' +
          'AUTH_TENANT_RLS_RUNTIME_ROLE to a non-owner role.',
        {
          connectionRole: posture.connectionRole,
          effectiveRole: posture.effectiveRole,
          unforcedOwnedRlsTables: posture.unforcedOwnedRlsTables,
        },
      );
      return posture;
    }
    if (posture.reason === 'replica_role_bypasses_rls') {
      logger.error(
        'TENANT RLS IS PARTIALLY INERT ON THE READ REPLICA: AUTH_ENFORCE_TENANT_RLS=true and the ' +
          'primary role is sound, but the read replica (DATABASE_READ_URL) effective role ' +
          `'${posture.replicaEffectiveRole}' has SUPERUSER/BYPASSRLS — every tenant-scoped read routed ` +
          'to the replica (setTenant/setTenantTx { readOnly:true }) silently bypasses RLS, so ' +
          'analytics/dashboard/export reads can leak cross-tenant. Connect the replica as a ' +
          'non-superuser, non-BYPASSRLS role, or set AUTH_TENANT_RLS_RUNTIME_ROLE to one.',
        {
          connectionRole: posture.connectionRole,
          effectiveRole: posture.effectiveRole,
          replicaConnectionRole: posture.replicaConnectionRole,
          replicaEffectiveRole: posture.replicaEffectiveRole,
        },
      );
      return posture;
    }
    logger.error(
      "TENANT RLS IS NOT ENFORCED: AUTH_ENFORCE_TENANT_RLS=true but the effective DB role " +
        `'${posture.effectiveRole}' has SUPERUSER/BYPASSRLS — every tenant_isolation policy is ` +
        'silently bypassed (Postgres bypasses RLS for super/bypassrls roles even under FORCE). ' +
        'Connect as a non-superuser, non-BYPASSRLS role, or set AUTH_TENANT_RLS_RUNTIME_ROLE to one.',
      {
        connectionRole: posture.connectionRole,
        testRole: posture.testRole,
        effectiveRole: posture.effectiveRole,
      },
    );
    return posture;
  }
  logger.info('Tenant RLS posture OK — isolation will enforce', {
    effectiveRole: posture.effectiveRole,
    via: posture.testRole ? 'SET LOCAL ROLE' : 'connection role',
    connectionRole: posture.connectionRole,
    connectionRoleRlsSubject: posture.connectionRoleRlsSubject,
    restrictiveForcedTables: posture.restrictiveForcedTables,
  });
  if (posture.testRole && posture.connectionRoleRlsSubject && posture.restrictiveForcedTables > 0) {
    // The runtime role only applies INSIDE setTenant/setTenantTx. Everything
    // else — the pre-auth writers under /api/v1/auth in particular — runs as
    // the bare connection role, which is itself subject to RLS here, so a
    // write outside a tenant transaction to one of these FORCE-RLS tables
    // with a RESTRICTIVE explicit-tenant-context policy is rejected 42501
    // rather than silently allowed. Pre-auth identity creation is pinned to
    // setTenantTx by src/tests/unit/preAuthIdentityCreationTenantScope.test.js
    // and proven live by src/tests/preauth-identity-creation-rls.deep.test.js.
    logger.info('Tenant RLS: the bare connection role is RLS-subject; writes outside a tenant transaction to RESTRICTIVE-policy tables are rejected', {
      connectionRole: posture.connectionRole,
      restrictiveForcedTables: posture.restrictiveForcedTables,
    });
  }
  return posture;
}

/**
 * CAN-040: decide whether an unsafe tenant-RLS posture must FAIL CLOSED at boot.
 * Production refuses to start when RLS is disabled (`!enforced`) or inert
 * (`!ok` — effective role bypasses RLS / owns unforced policy tables) so a
 * misconfigured deployment can't silently serve PHI with isolation off. A
 * probe error is unsafe because the service cannot prove isolation. An explicit,
 * audited override (`AUTH_TENANT_RLS_FAIL_OPEN=true`) is honoured for a
 * confirmed single-tenant maintenance window. Non-production never fails closed.
 * Pure + env-injectable so the boot guard is unit-testable.
 */
export function tenantRlsPostureMustFailClosed(posture, env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() !== 'production') return false;
  if (String(env.AUTH_TENANT_RLS_FAIL_OPEN || '').toLowerCase() === 'true') return false;
  if (!posture || posture.error) return true;
  return !posture.enforced || !posture.ok;
}

/**
 * Idempotent boot-time provisioning of the tenant-RLS runtime role's
 * privileges (roadmap A2). Why boot-time and not only a migration:
 *
 *   * On CNPG prod the role itself is created declaratively by the operator
 *     (`spec.managed.roles` → vhhealth_app, NOLOGIN NOSUPERUSER NOBYPASSRLS)
 *     and the operator may reconcile it AFTER the first migration pass on a
 *     fresh cluster. A tracker-driven migration runs exactly once per DB —
 *     if the role didn't exist yet, the grants would be skipped forever.
 *   * On dev/QA/dalekdefender the connection role is a superuser, so this
 *     function can also CREATE the role outright (same SQL as
 *     overlays/dalekdefender/rls-runtime-role.sql).
 *
 * Generic grant repair remains tolerant: missing CREATEROLE privilege
 * downgrades to a NOTICE and the table owner can still repair objects it owns.
 * The migration-753 protected funding family is different: failure to close
 * a previously broad runtime role is fatal, because that role could remain
 * usable with stale mutation or SECURITY DEFINER authority.
 */
export async function ensureTenantRlsRuntimeRoleGrants() {
  const role = tenantRlsRuntimeRole();
  if (!role) return { skipped: true, reason: 'no_runtime_role_configured' };
  if (!/^[a-z_][a-z0-9_]*$/i.test(role)) {
    logger.error('Tenant RLS runtime role name is not a safe identifier — skipping grants', { role });
    return { skipped: true, reason: 'unsafe_role_name' };
  }
  const sql = `
DO $$
DECLARE
  med03_relation TEXT;
  med03_sequence TEXT;
  med03_trigger_function TEXT;
  med03_runtime_wrapper_function TEXT;
  med03_column_list TEXT;
  runtime_acl_relation TEXT;
  runtime_acl_sequence TEXT;
  runtime_acl_function TEXT;
  funding_acl_role TEXT;
  funding_acl_column_list TEXT;
  funding_acl_function RECORD;
  runtime_read_only_relations CONSTANT TEXT[] := ARRAY[
    'clinical_continuity_policy_versions',
    'clinical_continuity_replay_receipts',
    'external_recovery_operability_actions',
    'external_recovery_critical_review_obligations',
    'external_recovery_critical_review_acknowledgements',
    'clinical_continuity_incident_packets',
    'clinical_continuity_incident_contact_sheets',
    'clinical_continuity_incident_contact_sheet_approvals',
    'clinical_continuity_incident_packet_allocations',
    'clinical_continuity_incident_packet_artifacts',
    'clinical_continuity_incident_packet_custody_events',
    'clinical_import_authority_events'
  ];
  runtime_append_only_relations CONSTANT TEXT[] := ARRAY[
    'care_pathway_reconciliation_checks',
    'clinical_continuity_replay_effect_evidence',
    'clinical_continuity_replay_attempts',
    'clinical_continuity_incident_declarations',
    'clinical_continuity_incident_aliases',
    'clinical_continuity_paper_range_decisions',
    'clinical_continuity_retrospective_facts',
    'clinical_continuity_reconciliation_decisions',
    'clinical_continuity_incident_attestations',
    'clinical_continuity_patient_merge_decisions',
    'notification_delivery_attempts',
    'notification_provider_receipts',
    'hl7_outbound_transport_attempts',
    'hl7_outbound_transport_results',
    'hl7_outbound_acknowledgements',
    'interop_backend_delivery_receipts',
    'interop_message_attempts',
    'imaging_study_link_recovery_receipts',
    'scim_provisioning_commands',
    'hl7_inbound_clinical_receipts',
    'fhir_allergy_intolerance_receipts'
  ];
  runtime_mutable_no_delete_relations CONSTANT TEXT[] := ARRAY[
    'clinical_continuity_incidents',
    'clinical_continuity_paper_ranges',
    'clinical_continuity_temporary_identities',
    'clinical_continuity_paper_items',
    'clinical_continuity_reconciliation_items',
    'clinical_continuity_reconciliation_config',
    'clinical_continuity_device_journal_offsets',
    'clinical_continuity_incident_interfaces',
    'notification_delivery_cursors',
    'hl7_feed_subscriptions',
    'hl7_outbound_messages',
    'hl7_outbound_delivery_cursors',
    'scheduled_job_runs',
    'scheduled_job_tenant_runs',
    'patient_bloodborne_markers'
  ];
  runtime_nextval_sequences CONSTANT TEXT[] := ARRAY[
    'care_pathway_reconciliation_checks_id_seq',
    'clinical_continuity_replay_attempts_id_seq',
    'hl7_feed_subscriptions_id_seq',
    'hl7_outbound_messages_id_seq',
    'interop_backend_delivery_receipts_id_seq',
    'imaging_study_link_recovery_receipts_id_seq',
    'scim_provisioning_commands_id_seq',
    'hl7_inbound_clinical_receipts_id_seq',
    'scheduled_job_runs_id_seq',
    'patient_bloodborne_markers_id_seq'
  ];
  runtime_guard_functions CONSTANT TEXT[] := ARRAY[
    'care_pathway_reconciliation_block_mutation()',
    'clinical_continuity_action_registry_guard_version()',
    'clinical_continuity_action_registry_guard_update()',
    'clinical_continuity_action_registry_approval_constraint()',
    'assert_external_recovery_inbox_immutable()',
    'assert_external_recovery_effect_allowed()',
    'assert_cc_replay_receipt_mutation()',
    'assert_cc_replay_append_only()',
    'assert_cc_reconciliation_append_only()',
    'assert_cc_reconciliation_projection_mutation()',
    'assert_cc_incident_packet_mutation()',
    'assert_cc_incident_alias_acyclic()',
    'assert_cc_closure_actor_separation()',
    'notification_outbox_prepare_intent()',
    'validate_notification_delivery_attempt()',
    'notification_delivery_evidence_append_only()',
    'validate_notification_recovery_receipt()',
    'validate_notification_delivery_cursor()',
    'validate_notification_outbox_transition()',
    'validate_hl7_outbound_transport_attempt()',
    'hl7_outbound_evidence_append_only()',
    'validate_hl7_outbound_acknowledgement()',
    'validate_hl7_outbound_cursor()',
    'validate_hl7_outbound_message_transition()',
    'validate_hl7_outbound_recovery_provenance()',
    'interop_delivery_evidence_append_only()',
    'validate_interop_backend_receipt()',
    'validate_interop_message_recovery_transition()',
    'validate_interop_message_recovery_provenance()',
    'validate_imaging_study_link_recovery_receipt()',
    'imaging_study_link_receipt_append_only()',
    'validate_scim_provisioning_command()',
    'scim_provisioning_command_append_only()',
    'external_recovery_evidence_owner_only()',
    'external_recovery_evidence_append_only()',
    'external_recovery_operability_bound_hash(text[])',
    'external_recovery_operability_offset_guard()',
    'external_recovery_critical_review_completion_guard()',
    'cc_packet_assert_context(uuid,integer)',
    'cc_packet_active_policy(uuid,integer)',
    'cc_packet_assert_actor(uuid,uuid,text)',
    'cc_packet_assert_contact_content(jsonb)',
    'assert_cc_packet_evidence_append_only()',
    'assert_cc_packet_allocation_mutation()',
    'scheduled_job_run_transition_guard()',
    'scheduled_job_run_finalization_guard()',
    'scheduled_job_tenant_run_transition_guard()',
    'clinical_import_receipt_append_only_755()',
    'clinical_import_document_authority_guard_755()',
    'clinical_import_resource_authority_guard_755()',
    'clinical_import_document_completeness_guard_755()',
    'clinical_import_patient_merge_lock_held_755(uuid)',
    'clinical_import_history_immutable_755()',
    'clinical_import_history_receipt_guard_755()',
    'clinical_import_append_only_guard_760()',
    'clinical_import_authority_event_guard_760()',
    'clinical_import_raw_artifact_guard_760()',
    'clinical_import_reconciliation_item_guard_760()',
    'clinical_import_active_patient_survivor_760(uuid,uuid)',
    'clinical_import_reconciliation_event_guard_760()',
    'clinical_import_failed_receipt_reconciliation_guard_760()',
    'clinical_import_resource_correction_guard_760()'
  ];
  med03_mutable_relations CONSTANT TEXT[] := ARRAY[
    'ward_indent_inventory_allocations',
    'billing_credit_notes',
    'clinical_alert_delivery_obligations',
    'clinical_alert_delivery_recovery_cases',
    'mar_medication_exception_cases'
  ];
  med03_append_only_relations CONSTANT TEXT[] := ARRAY[
    'pharmacy_stock_movements',
    'pharmacy_schedule_register',
    'ward_indent_events',
    'ward_indent_inventory_movement_links',
    'ward_indent_inventory_receipt_events',
    'mar_supply_consumptions',
    'mar_administration_command_receipts',
    'mar_transition_command_receipts',
    'mar_supply_reconciliation_links',
    'mar_supply_reconciliation_command_receipts',
    'ward_indent_financial_events',
    'billing_credit_note_events',
    'mar_medication_exception_events'
  ];
  med03_trigger_functions CONSTANT TEXT[] := ARRAY[
    'medication_evidence_append_only_guard',
    'medication_administration_require_order_context',
    'controlled_ward_dispense_require_patient',
    'ward_indent_inventory_allocation_guard',
    'ward_indent_controlled_patient_guard',
    'ward_indent_apply_inventory_movement_link',
    'ward_indent_apply_inventory_receipt_event',
    'ward_indent_inventory_workflow_event_validate',
    'ward_indent_inventory_allocation_evidence_validate',
    'mar_supply_apply_custody_consumption',
    'mar_administration_command_receipt_validate',
    'mar_transition_command_receipt_validate',
    'mar_supply_apply_reconciliation_link',
    'ward_indent_validate_financial_event_lineage',
    'billing_credit_note_event_state_validate',
    'billing_credit_note_require_context',
    'billing_credit_note_require_lifecycle_event',
    'ward_medication_tasks_sync_workflow_sla_compat',
    'clinical_alert_delivery_obligation_guard',
    'clinical_alert_delivery_recovery_case_guard',
    'clinical_alert_delivery_recovery_action_guard',
    'clinical_alert_delivery_recovery_task_sync',
    'clinical_alert_delivery_recovery_task_case_constraint',
    'clinical_alert_delivery_recovery_obligation_constraint',
    'clinical_alert_delivery_recovery_claim_comment_guard',
    'clinical_alert_delivery_recovery_assignee_viability_guard',
    'mar_medication_exception_case_guard',
    'mar_medication_exception_case_receipt_guard',
    'mar_medication_exception_claim_comment_guard',
    'mar_medication_exception_assignee_viability_guard',
    'mar_medication_exception_tasks_sync_workflow_sla_compat',
    'counter_sale_void_request_guard',
    'counter_sale_void_refund_guard',
    'counter_sale_void_sale_guard',
    'counter_sale_void_stock_return_guard',
    'counter_sale_void_allocation_return_guard',
    'counter_sale_void_request_terminal_evidence',
    'counter_sale_void_task_sync',
    'counter_sale_void_task_binding_evidence',
    'billing_refund_offline_electronic_evidence_guard_747',
    'billing_refund_offline_electronic_binding_guard_747',
    'billing_refund_payout_guard_747',
    'cash_drawer_reconciliation_guard_747',
    'billing_cash_payment_reversal_guard_747',
    'cath_inventory_shortfall_task_sync',
    'cath_inventory_shortfall_contract_constraint'
  ];
  med03_runtime_wrapper_functions CONSTANT TEXT[] := ARRAY[
    'care_pathway_assert_task_sla_source_binding(UUID, INTEGER)',
    'care_pathway_assert_task_sla_source_binding_pre_748(UUID, INTEGER)',
    'care_pathway_assert_task_sla_source_binding_pre_746(UUID, INTEGER)',
    'care_pathway_assert_task_sla_source_binding_pre_745(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_748(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_746(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_745(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_mar_exception(UUID, INTEGER)',
    'care_pathway_assert_task_sla_completion_receipt_pre_med03(UUID, INTEGER)'
  ];
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    BEGIN
      CREATE ROLE ${role} NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'cannot CREATE ROLE ${role} (no CREATEROLE) — expecting it to be provisioned externally (CNPG managed.roles)';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    BEGIN
      IF '${role}' = 'vhhealth_runtime' THEN
        ALTER ROLE ${role}
          LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
          NOREPLICATION INHERIT;
      ELSE
        ALTER ROLE ${role}
          NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
          NOREPLICATION INHERIT;
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'cannot enforce role posture for ${role} (no CREATEROLE) — expecting it to be provisioned externally (CNPG managed.roles)';
    END;
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${role}', current_database());
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
      REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${role};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role};
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'broad object grants for ${role} skipped (executing role lacks privilege on some objects)';
    END;
    BEGIN
      -- Migration 753 funding receipts and advance reservations are a
      -- deny-first family. Revoke every matching relation before applying the
      -- exact known column allowlist; an unknown matching object present at
      -- reconciliation stays inaccessible until this bootstrap is extended.
      -- Runtime defaults are globally deny-first as well: a new object gets
      -- no application authority until its owning migration grants the exact
      -- current-object contract and this bootstrap learns its recovery ACL.
      IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_roles runtime_posture
          JOIN (
            SELECT DISTINCT candidate.role_name
              FROM pg_catalog.unnest(
                ARRAY['${role}','vhhealth_app','vhhealth_runtime']::TEXT[]
              ) AS candidate(role_name)
          ) protected_runtime
            ON protected_runtime.role_name=runtime_posture.rolname
         WHERE (
             runtime_posture.rolsuper
             OR runtime_posture.rolbypassrls
             OR runtime_posture.rolcreatedb
             OR runtime_posture.rolcreaterole
             OR runtime_posture.rolreplication
             OR NOT runtime_posture.rolinherit
             OR (
               runtime_posture.rolname='vhhealth_runtime'
               AND NOT runtime_posture.rolcanlogin
             )
             OR (
               runtime_posture.rolname<>'vhhealth_runtime'
               AND runtime_posture.rolcanlogin
             )
           )
      ) THEN
        RAISE EXCEPTION 'migration-753 runtime role posture is unsafe'
          USING ERRCODE='V7530';
      END IF;
      IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_roles runtime_posture
          JOIN (
            SELECT DISTINCT candidate.role_name
              FROM pg_catalog.unnest(
                ARRAY['${role}','vhhealth_app','vhhealth_runtime']::TEXT[]
              ) AS candidate(role_name)
          ) protected_runtime
            ON protected_runtime.role_name=runtime_posture.rolname
         CROSS JOIN pg_catalog.pg_roles assumable_role
         WHERE assumable_role.oid<>runtime_posture.oid
           AND (
             pg_catalog.pg_has_role(
               runtime_posture.oid,assumable_role.oid,'MEMBER'
             )
             OR pg_catalog.pg_has_role(
               runtime_posture.oid,assumable_role.oid,'USAGE'
             )
             OR pg_catalog.pg_has_role(
               runtime_posture.oid,assumable_role.oid,'SET'
             )
           )
           AND (
             assumable_role.rolsuper
             OR assumable_role.rolbypassrls
             OR assumable_role.rolcreatedb
             OR assumable_role.rolcreaterole
             OR assumable_role.rolreplication
             OR assumable_role.oid=(
               SELECT database.datdba
                 FROM pg_catalog.pg_database database
                WHERE database.datname=pg_catalog.current_database()
             )
             OR EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_namespace namespace
                WHERE namespace.nspname='public'
                  AND namespace.nspowner=assumable_role.oid
             )
             OR EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_class relation
                WHERE relation.relnamespace='public'::pg_catalog.regnamespace
                  AND relation.relowner=assumable_role.oid
             )
             OR EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_proc routine
                WHERE routine.pronamespace='public'::pg_catalog.regnamespace
                  AND routine.proowner=assumable_role.oid
             )
           )
      ) THEN
        RAISE EXCEPTION 'migration-753 runtime role can assume privileged authority'
          USING ERRCODE='V7530';
      END IF;
      ALTER DEFAULT PRIVILEGES
        REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES
        REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES
        REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
      FOR runtime_acl_relation IN
        SELECT relation.relname
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='public'
           AND relation.relkind IN ('r','p')
           AND (
             pg_catalog.left(relation.relname,17)='pharmacy_advance_'
             OR relation.relname IN (
               'pharmacy_order_command_receipts',
               'pharmacy_funding_commands',
               'billing_advance_settlements'
             )
           )
         ORDER BY relation.relname
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC',
          runtime_acl_relation
        );
        SELECT pg_catalog.string_agg(
                 pg_catalog.quote_ident(attribute.attname),
                 ', ' ORDER BY attribute.attnum
               )
          INTO funding_acl_column_list
          FROM pg_catalog.pg_attribute attribute
         WHERE attribute.attrelid=pg_catalog.to_regclass(
                 pg_catalog.format('public.%I',runtime_acl_relation)
               )
           AND attribute.attnum>0
           AND NOT attribute.attisdropped;
        IF funding_acl_column_list IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE SELECT (%s) ON TABLE public.%I FROM PUBLIC',
            funding_acl_column_list,
            runtime_acl_relation
          );
          EXECUTE pg_catalog.format(
            'REVOKE INSERT (%s) ON TABLE public.%I FROM PUBLIC',
            funding_acl_column_list,
            runtime_acl_relation
          );
          EXECUTE pg_catalog.format(
            'REVOKE UPDATE (%s) ON TABLE public.%I FROM PUBLIC',
            funding_acl_column_list,
            runtime_acl_relation
          );
          EXECUTE pg_catalog.format(
            'REVOKE REFERENCES (%s) ON TABLE public.%I FROM PUBLIC',
            funding_acl_column_list,
            runtime_acl_relation
          );
        END IF;
      END LOOP;
      FOR runtime_acl_sequence IN
        SELECT sequence.relname
          FROM pg_catalog.pg_class sequence
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid=sequence.relnamespace
         WHERE namespace.nspname='public'
           AND sequence.relkind='S'
           AND (
             pg_catalog.left(sequence.relname,17)='pharmacy_advance_'
             OR sequence.relname IN (
               'pharmacy_order_command_receipts_id_seq',
               'pharmacy_funding_commands_id_seq',
               'billing_advance_settlements_id_seq'
             )
           )
         ORDER BY sequence.relname
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC',
          runtime_acl_sequence
        );
      END LOOP;
      FOR funding_acl_function IN
        SELECT routine.proname,
               pg_catalog.pg_get_function_identity_arguments(routine.oid) AS arguments
          FROM pg_catalog.pg_proc routine
          JOIN pg_catalog.pg_namespace namespace
            ON namespace.oid=routine.pronamespace
         WHERE namespace.nspname='public'
           AND routine.prokind='f'
           AND routine.prosecdef
           AND pg_catalog.right(routine.proname,4)='_753'
         ORDER BY routine.proname,arguments
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION public.%I(%s) FROM PUBLIC',
          funding_acl_function.proname,
          funding_acl_function.arguments
        );
      END LOOP;
      FOR funding_acl_role IN
        SELECT DISTINCT candidate.role_name
          FROM pg_catalog.unnest(
            ARRAY['${role}','vhhealth_app','vhhealth_runtime']::TEXT[]
          ) AS candidate(role_name)
         WHERE pg_catalog.to_regrole(candidate.role_name) IS NOT NULL
         ORDER BY candidate.role_name
      LOOP
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM %I',
          funding_acl_role
        );
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
          funding_acl_role
        );
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I',
          funding_acl_role
        );
        EXECUTE pg_catalog.format(
          'REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM %I',
          funding_acl_role
        );
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
          funding_acl_role
        );
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
          funding_acl_role
        );
        EXECUTE pg_catalog.format(
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I',
          funding_acl_role
        );
        FOR runtime_acl_relation IN
          SELECT relation.relname
            FROM pg_catalog.pg_class relation
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid=relation.relnamespace
           WHERE namespace.nspname='public'
             AND relation.relkind IN ('r','p')
             AND (
               pg_catalog.left(relation.relname,17)='pharmacy_advance_'
               OR relation.relname IN (
                 'pharmacy_order_command_receipts',
                 'pharmacy_funding_commands',
                 'billing_advance_settlements'
               )
             )
           ORDER BY relation.relname
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
            runtime_acl_relation,
            funding_acl_role
          );
          SELECT pg_catalog.string_agg(
                   pg_catalog.quote_ident(attribute.attname),
                   ', ' ORDER BY attribute.attnum
                 )
            INTO funding_acl_column_list
            FROM pg_catalog.pg_attribute attribute
           WHERE attribute.attrelid=pg_catalog.to_regclass(
                   pg_catalog.format('public.%I',runtime_acl_relation)
                 )
             AND attribute.attnum>0
             AND NOT attribute.attisdropped;
          IF funding_acl_column_list IS NOT NULL THEN
            EXECUTE pg_catalog.format(
              'REVOKE SELECT (%s) ON TABLE public.%I FROM %I',
              funding_acl_column_list,
              runtime_acl_relation,
              funding_acl_role
            );
            EXECUTE pg_catalog.format(
              'REVOKE INSERT (%s) ON TABLE public.%I FROM %I',
              funding_acl_column_list,
              runtime_acl_relation,
              funding_acl_role
            );
            EXECUTE pg_catalog.format(
              'REVOKE UPDATE (%s) ON TABLE public.%I FROM %I',
              funding_acl_column_list,
              runtime_acl_relation,
              funding_acl_role
            );
            EXECUTE pg_catalog.format(
              'REVOKE REFERENCES (%s) ON TABLE public.%I FROM %I',
              funding_acl_column_list,
              runtime_acl_relation,
              funding_acl_role
            );
          END IF;
        END LOOP;
        FOR runtime_acl_sequence IN
          SELECT sequence.relname
            FROM pg_catalog.pg_class sequence
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid=sequence.relnamespace
           WHERE namespace.nspname='public'
             AND sequence.relkind='S'
             AND (
               pg_catalog.left(sequence.relname,17)='pharmacy_advance_'
               OR sequence.relname IN (
                 'pharmacy_order_command_receipts_id_seq',
                 'pharmacy_funding_commands_id_seq',
                 'billing_advance_settlements_id_seq'
               )
             )
           ORDER BY sequence.relname
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I',
            runtime_acl_sequence,
            funding_acl_role
          );
        END LOOP;
        FOR funding_acl_function IN
          SELECT routine.proname,
                 pg_catalog.pg_get_function_identity_arguments(routine.oid) AS arguments
            FROM pg_catalog.pg_proc routine
            JOIN pg_catalog.pg_namespace namespace
              ON namespace.oid=routine.pronamespace
           WHERE namespace.nspname='public'
             AND routine.prokind='f'
             AND routine.prosecdef
             AND pg_catalog.right(routine.proname,4)='_753'
           ORDER BY routine.proname,arguments
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON FUNCTION public.%I(%s) FROM %I',
            funding_acl_function.proname,
            funding_acl_function.arguments,
            funding_acl_role
          );
        END LOOP;
        IF pg_catalog.to_regclass('public.pharmacy_order_command_receipts') IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE public.pharmacy_order_command_receipts TO %I',
            funding_acl_role
          );
          EXECUTE pg_catalog.format(
            'GRANT INSERT (
               tenant_id,pharmacy_order_id,action,command_key_sha256,
               request_sha256,response_payload,response_message
             ) ON TABLE public.pharmacy_order_command_receipts TO %I',
            funding_acl_role
          );
        END IF;
        IF pg_catalog.to_regclass('public.billing_advance_settlements') IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE public.billing_advance_settlements TO %I',
            funding_acl_role
          );
          EXECUTE pg_catalog.format(
            'GRANT INSERT (
               advance_id,invoice_id,amount,settled_by
             ) ON TABLE public.billing_advance_settlements TO %I',
            funding_acl_role
          );
        END IF;
        IF pg_catalog.to_regclass('public.pharmacy_funding_commands') IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE public.pharmacy_funding_commands TO %I',
            funding_acl_role
          );
          EXECUTE pg_catalog.format(
            'GRANT INSERT (
               tenant_id,command_key_sha256,command_type,task_id,
               task_resource_type,task_resource_id,pharmacy_order_id,
               facility_id,invoice_id,invoice_item_id,tpa_claim_id,
               approval_receipt_id,consumption_receipt_id,
               governance_approval_id,proposal_sha256,proposer_uid,
               release_reason,release_source_approval_id,
               request_sha256,created_by
             ) ON TABLE public.pharmacy_funding_commands TO %I',
            funding_acl_role
          );
        END IF;
        IF pg_catalog.to_regclass('public.pharmacy_advance_allocations') IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE public.pharmacy_advance_allocations TO %I',
            funding_acl_role
          );
        END IF;
        IF pg_catalog.to_regclass('public.pharmacy_advance_allocation_reversals') IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE public.pharmacy_advance_allocation_reversals TO %I',
            funding_acl_role
          );
          EXECUTE pg_catalog.format(
            'GRANT INSERT (
               tenant_id,allocation_id,pharmacy_order_id,invoice_id,
               invoice_item_id,billing_advance_id,source_authority_version,
               source_authority_sha256,funding_task_id,
               funding_approval_receipt_id,allocation_evidence_sha256,
               reversed_amount,reversal_command_sha256,reason,
               billing_advance_settlement_id,funding_settlement_receipt_id,
               funding_release_receipt_id,reversed_by,evidence
             ) ON TABLE public.pharmacy_advance_allocation_reversals TO %I',
            funding_acl_role
          );
        END IF;
        IF pg_catalog.to_regclass('public.pharmacy_advance_allocation_consumptions') IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE public.pharmacy_advance_allocation_consumptions TO %I',
            funding_acl_role
          );
          EXECUTE pg_catalog.format(
            'GRANT INSERT (
               tenant_id,allocation_id,pharmacy_order_id,invoice_id,
               invoice_item_id,billing_advance_id,source_authority_version,
               source_authority_sha256,funding_task_id,
               funding_approval_receipt_id,allocation_evidence_sha256,
               funding_consumption_receipt_id,consumption_command_sha256,
               consumed_by,evidence
             ) ON TABLE public.pharmacy_advance_allocation_consumptions TO %I',
            funding_acl_role
          );
        END IF;
        FOREACH runtime_acl_sequence IN ARRAY ARRAY[
          'pharmacy_order_command_receipts_id_seq',
          'pharmacy_funding_commands_id_seq',
          'billing_advance_settlements_id_seq',
          'pharmacy_advance_allocation_reversals_id_seq',
          'pharmacy_advance_allocation_consumptions_id_seq'
        ]::TEXT[]
        LOOP
          IF pg_catalog.to_regclass(
            pg_catalog.format('public.%I',runtime_acl_sequence)
          ) IS NOT NULL THEN
            EXECUTE pg_catalog.format(
              'GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I',
              runtime_acl_sequence,
              funding_acl_role
            );
          END IF;
        END LOOP;
        IF pg_catalog.to_regprocedure(
          'public.complete_pharmacy_funding_command_753(uuid,bigint,uuid,jsonb)'
        ) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT EXECUTE ON FUNCTION public.complete_pharmacy_funding_command_753(UUID,BIGINT,UUID,JSONB) TO %I',
            funding_acl_role
          );
        END IF;
        IF pg_catalog.to_regprocedure(
          'public.reserve_pharmacy_advance_allocations_753(uuid,bigint,uuid)'
        ) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT EXECUTE ON FUNCTION public.reserve_pharmacy_advance_allocations_753(UUID,BIGINT,UUID) TO %I',
            funding_acl_role
          );
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE='V7530',
        MESSAGE='migration-753 protected runtime ACL reconciliation failed',
        DETAIL=pg_catalog.format('original SQLSTATE %s: %s',SQLSTATE,SQLERRM);
    END;
    -- End of the fail-closed migration-753 funding ACL reconciliation.
    BEGIN
      -- Broad grants are the late-provisioning fallback. Reconstruct every
      -- migration-defined narrow ACL immediately afterwards so startup cannot
      -- turn append-only evidence, owner-only mutation, or setval back on.
      FOREACH runtime_acl_relation IN ARRAY runtime_read_only_relations
      LOOP
        IF pg_catalog.to_regclass(pg_catalog.format('public.%I', runtime_acl_relation)) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
            runtime_acl_relation,
            '${role}'
          );
          EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE public.%I TO %I',
            runtime_acl_relation,
            '${role}'
          );
        END IF;
      END LOOP;
      FOREACH runtime_acl_relation IN ARRAY runtime_append_only_relations
      LOOP
        IF pg_catalog.to_regclass(pg_catalog.format('public.%I', runtime_acl_relation)) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
            runtime_acl_relation,
            '${role}'
          );
          EXECUTE pg_catalog.format(
            'GRANT SELECT, INSERT ON TABLE public.%I TO %I',
            runtime_acl_relation,
            '${role}'
          );
        END IF;
      END LOOP;
      IF pg_catalog.to_regclass('public.clinical_import_raw_artifacts') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_raw_artifacts FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (id, tenant_id, authority_grant_id, patient_uid, source_facility_id, actor_uid, actor_role, source_system, source_document_id, document_format, raw_payload_sha256, raw_payload_bytes, raw_content_type, raw_payload_ciphertext, encryption_key_id, canonicalization_version, canonical_payload_sha256, asserted_source_signature_sha256, signature_verification_status, source_author_evidence, recorded_by, contract_version) ON TABLE public.clinical_import_raw_artifacts TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT (id, tenant_id, authority_grant_id, patient_uid, source_facility_id, actor_uid, actor_role, source_system, source_document_id, document_format, raw_payload_sha256, raw_payload_bytes, raw_content_type, canonicalization_version, canonical_payload_sha256, asserted_source_signature_sha256, signature_verification_status, source_author_evidence_sha256, recorded_by, contract_version, created_at) ON TABLE public.clinical_import_raw_artifacts TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.clinical_import_document_receipts') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_document_receipts FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.clinical_import_document_receipts TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (id, tenant_id, patient_id, patient_uid, source_facility_id, authority_grant_id, raw_artifact_id, patient_identifier_ids, patient_identity_binding_sha256, access_decision_evidence, source_author_evidence, actor_uid, actor_role, ingestion_mode, document_format, source_system, source_document_id, asserted_source_signature_sha256, source_payload_sha256, source_identity_sha256, idempotency_key_sha256, resource_manifest_sha256, resource_manifest, result, status, request_id, canonical_timeline_event_id, canonical_audit_event_id, contract_version) ON TABLE public.clinical_import_document_receipts TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.clinical_import_resource_receipts') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_resource_receipts FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.clinical_import_resource_receipts TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (id, tenant_id, document_receipt_id, patient_uid, source_resource_type, source_resource_id, source_resource_index, source_identity_sha256, payload_sha256, outcome, target_table, target_id, canonical_timeline_event_id, canonical_audit_event_id, evidence, correction_reconciliation_item_id, correction_original_resource_receipt_id, correction_retry_event_id, contract_version) ON TABLE public.clinical_import_resource_receipts TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.clinical_import_reconciliation_items') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_reconciliation_items FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.clinical_import_reconciliation_items TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (id, tenant_id, resource_receipt_id, document_receipt_id, patient_uid, facility_id, owner_actor_uid, owner_actor_role, reason, idempotency_key_sha256, contract_version) ON TABLE public.clinical_import_reconciliation_items TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.clinical_import_reconciliation_events') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.clinical_import_reconciliation_events FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.clinical_import_reconciliation_events TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (id, tenant_id, reconciliation_item_id, resource_receipt_id, document_receipt_id, patient_uid, facility_id, event_type, actor_uid, actor_role, reason, predecessor_event_id, replacement_resource_receipt_id, idempotency_key_sha256, evidence, contract_version) ON TABLE public.clinical_import_reconciliation_events TO %I',
          '${role}'
        );
      END IF;
      FOREACH runtime_acl_relation IN ARRAY runtime_mutable_no_delete_relations
      LOOP
        IF pg_catalog.to_regclass(pg_catalog.format('public.%I', runtime_acl_relation)) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
            runtime_acl_relation,
            '${role}'
          );
          EXECUTE pg_catalog.format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO %I',
            runtime_acl_relation,
            '${role}'
          );
        END IF;
      END LOOP;
      FOREACH runtime_acl_sequence IN ARRAY runtime_nextval_sequences
      LOOP
        IF pg_catalog.to_regclass(pg_catalog.format('public.%I', runtime_acl_sequence)) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I',
            runtime_acl_sequence,
            '${role}'
          );
          EXECUTE pg_catalog.format(
            'GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I',
            runtime_acl_sequence,
            '${role}'
          );
        END IF;
      END LOOP;
      FOREACH runtime_acl_function IN ARRAY runtime_guard_functions
      LOOP
        IF pg_catalog.to_regprocedure(
          pg_catalog.format('public.%s', runtime_acl_function)
        ) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON FUNCTION public.%s FROM %I',
            runtime_acl_function,
            '${role}'
          );
        END IF;
      END LOOP;
      IF pg_catalog.to_regprocedure(
        'public.lock_clinical_import_authority_760(uuid,uuid,uuid,integer,uuid,text,text)'
      ) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION public.lock_clinical_import_authority_760(UUID,UUID,UUID,INTEGER,UUID,TEXT,TEXT) TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.event_consumer_offsets') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
          ON TABLE public.event_consumer_offsets FROM ${role};
        GRANT SELECT ON TABLE public.event_consumer_offsets TO ${role};
        GRANT INSERT (
          scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, resume_cutoff_position, resume_cutoff_token,
          recovery_state, reconciliation_reason, policy_version,
          policy_signature, retention_policy, retention_until,
          historical_cutoff_event_id, backfill_cursor_event_id,
          backfill_completed_at, intake_retired_at
        ) ON TABLE public.event_consumer_offsets TO ${role};
        GRANT UPDATE (
          high_water_position, high_water_token, resume_cutoff_position,
          resume_cutoff_token, recovery_state, reconciliation_reason,
          intake_retired_at, updated_at
        ) ON TABLE public.event_consumer_offsets TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public.pathway_projector_inbox') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
          ON TABLE public.pathway_projector_inbox FROM ${role};
        GRANT SELECT ON TABLE public.pathway_projector_inbox TO ${role};
        GRANT INSERT (
          scope_kind, tenant_id, consumer_key, generation, event_id, offset_id,
          facility_id, interface_family, direction, source_partition,
          source_position, source_token, predecessor_token, duplicate_key,
          command_fingerprint, occurred_at, received_at, recorded_at,
          arrival_class, effect_disposition, status, next_attempt_at, policy_version,
          policy_signature, retention_policy, retention_until,
          lease_owner, lease_expires_at
        ) ON TABLE public.pathway_projector_inbox TO ${role};
        GRANT UPDATE (
          status, attempts, lease_owner, lease_expires_at, next_attempt_at,
          last_error, outcome_at, outcome_code, pending_task_id
        ) ON TABLE public.pathway_projector_inbox TO ${role};
      END IF;
      -- MED-03 evidence tables are either lifecycle-controlled or immutable.
      -- Reapply their narrow ACLs after every broad startup grant so a role
      -- reconciled after migration 744 cannot regain DELETE/UPDATE/setval.
      FOREACH med03_relation IN ARRAY med03_mutable_relations
      LOOP
        IF pg_catalog.to_regclass(pg_catalog.format('public.%I', med03_relation)) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
            med03_relation,
            '${role}'
          );
          EXECUTE pg_catalog.format(
            'GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO %I',
            med03_relation,
            '${role}'
          );
        END IF;
      END LOOP;
      IF pg_catalog.to_regclass('public.clinical_alert_delivery_obligations') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.clinical_alert_delivery_obligations FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.clinical_alert_delivery_obligations TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (
             tenant_id, obligation_key, source_table, source_id, source_event_key,
             failure_kind, patient_uid, encounter_id, origin_actor_uid, failure_code,
             recipient_policy, notification_intent, supersedes_obligation_id
           ) ON TABLE public.clinical_alert_delivery_obligations TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT UPDATE (
             status, attempt_count, last_attempted_at, next_attempt_at,
             last_error_code, completion_notification_outbox_id,
             completion_notification_outbox_ids, completion_recipient_ids,
             completion_evidence, completed_at, manual_hold_code,
             manual_hold_reason, held_at
           ) ON TABLE public.clinical_alert_delivery_obligations TO %I',
           '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.clinical_alert_delivery_recovery_cases') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.clinical_alert_delivery_recovery_cases FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.clinical_alert_delivery_recovery_cases TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (
             id, tenant_id, obligation_id, case_kind, status,
             workflow_sla_instance_id, task_id, due_at
           ) ON TABLE public.clinical_alert_delivery_recovery_cases TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT UPDATE (
             observation_count, last_observed_at,
             escalation_attempt_count, last_escalation_attempt_at,
             last_escalation_error_code, escalated_at,
             status, resolution_kind, resolution_action_id,
             replacement_obligation_id, resolved_by_uid,
             resolution_reason, resolution_evidence, resolved_at
           ) ON TABLE public.clinical_alert_delivery_recovery_cases TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.clinical_alert_delivery_recovery_actions') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.clinical_alert_delivery_recovery_actions FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.clinical_alert_delivery_recovery_actions TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (
             tenant_id, case_id, action_type, actor_uid, operator_reason,
             idempotency_key, command_sha256, request_id, outcome, response_payload
           ) ON TABLE public.clinical_alert_delivery_recovery_actions TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.pharmacy_counter_sale_void_requests') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.pharmacy_counter_sale_void_requests FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (
             tenant_id, counter_sale_id, invoice_id, patient_uid, amount,
             refund_mode, disposition, reason, requested_by, requested_by_name,
             requested_by_role, command_key, request_fingerprint, status, task_stage
           ) ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT UPDATE (
             refund_id, status, task_stage, task_id, workflow_sla_instance_id,
             last_checked_at, reconciled_at, reconciled_by, reconciliation_source,
             rejection_resolved_at, rejection_resolved_by, rejection_resolution,
             rejection_resolution_reason, updated_at
           ) ON TABLE public.pharmacy_counter_sale_void_requests TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.billing_refund_offline_electronic_evidence') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.billing_refund_offline_electronic_evidence FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.billing_refund_offline_electronic_evidence TO %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT INSERT (
             tenant_id, refund_id, original_payment_id, original_advance_id, mode,
             amount, provider_name, original_payment_reference,
             provider_refund_reference, provider_refunded_at, recorded_by
           ) ON TABLE public.billing_refund_offline_electronic_evidence TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.billing_refunds') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.billing_refunds FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.billing_refunds TO %I',
          '${role}'
        );
        SELECT pg_catalog.string_agg(
                 pg_catalog.quote_ident(allowed.column_name),
                 ', ' ORDER BY allowed.ordinality
               )
          INTO med03_column_list
          FROM pg_catalog.unnest(ARRAY[
            'patient_uid', 'invoice_id', 'advance_id', 'amount', 'reason',
            'mode', 'approval_status', 'raised_by', 'tenant_id',
            'counter_sale_void_request_id'
          ]::TEXT[]) WITH ORDINALITY AS allowed(column_name, ordinality)
         WHERE EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = 'public.billing_refunds'::regclass
              AND attribute.attname = allowed.column_name
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
         );
        IF med03_column_list IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT INSERT (%s) ON TABLE public.billing_refunds TO %I',
            med03_column_list,
            '${role}'
          );
        END IF;
        SELECT pg_catalog.string_agg(
                 pg_catalog.quote_ident(allowed.column_name),
                 ', ' ORDER BY allowed.ordinality
               )
          INTO med03_column_list
          FROM pg_catalog.unnest(ARRAY[
            'reference', 'approval_status', 'approved_by', 'approved_at',
            'rejected_by', 'rejected_at', 'rejection_reason', 'paid_at',
            'paid_by', 'updated_at', 'payout_rail', 'payout_rail_claimed_at',
            'gateway_refund_id', 'cash_drawer_session_id',
            'offline_electronic_evidence_id'
          ]::TEXT[]) WITH ORDINALITY AS allowed(column_name, ordinality)
         WHERE EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = 'public.billing_refunds'::regclass
              AND attribute.attname = allowed.column_name
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
         );
        IF med03_column_list IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT UPDATE (%s) ON TABLE public.billing_refunds TO %I',
            med03_column_list,
            '${role}'
          );
        END IF;
      END IF;
      IF pg_catalog.to_regclass('public.cash_drawer_sessions') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE public.cash_drawer_sessions FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT SELECT ON TABLE public.cash_drawer_sessions TO %I',
          '${role}'
        );
        SELECT pg_catalog.string_agg(
                 pg_catalog.quote_ident(allowed.column_name),
                 ', ' ORDER BY allowed.ordinality
               )
          INTO med03_column_list
          FROM pg_catalog.unnest(ARRAY[
            'tenant_id', 'cashier_uid', 'shift', 'opening_float'
          ]::TEXT[]) WITH ORDINALITY AS allowed(column_name, ordinality)
         WHERE EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = 'public.cash_drawer_sessions'::regclass
              AND attribute.attname = allowed.column_name
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
         );
        IF med03_column_list IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT INSERT (%s) ON TABLE public.cash_drawer_sessions TO %I',
            med03_column_list,
            '${role}'
          );
        END IF;
        SELECT pg_catalog.string_agg(
                 pg_catalog.quote_ident(allowed.column_name),
                 ', ' ORDER BY allowed.ordinality
               )
          INTO med03_column_list
          FROM pg_catalog.unnest(ARRAY[
            'closed_at', 'counted_total', 'counted_denominations',
            'system_total', 'variance', 'short_count', 'over_count',
            'requires_review', 'variance_reason', 'status', 'reviewed_by',
            'reviewed_at', 'review_notes', 'updated_at', 'cash_inflow_total',
            'cash_refund_total'
          ]::TEXT[]) WITH ORDINALITY AS allowed(column_name, ordinality)
         WHERE EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute attribute
            WHERE attribute.attrelid = 'public.cash_drawer_sessions'::regclass
              AND attribute.attname = allowed.column_name
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
         );
        IF med03_column_list IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'GRANT UPDATE (%s) ON TABLE public.cash_drawer_sessions TO %I',
            med03_column_list,
            '${role}'
          );
        END IF;
      END IF;
      FOREACH med03_relation IN ARRAY med03_append_only_relations
      LOOP
        IF pg_catalog.to_regclass(pg_catalog.format('public.%I', med03_relation)) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
            med03_relation,
            '${role}'
          );
          EXECUTE pg_catalog.format(
            'GRANT SELECT, INSERT ON TABLE public.%I TO %I',
            med03_relation,
            '${role}'
          );
        END IF;
      END LOOP;
      FOREACH med03_relation IN ARRAY (
        med03_mutable_relations || med03_append_only_relations
      )
      LOOP
        med03_sequence := med03_relation || '_id_seq';
        IF pg_catalog.to_regclass(pg_catalog.format('public.%I', med03_sequence)) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I',
            med03_sequence,
            '${role}'
          );
          EXECUTE pg_catalog.format(
            'GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I',
            med03_sequence,
            '${role}'
          );
        END IF;
      END LOOP;
      IF pg_catalog.to_regclass('public.clinical_alert_delivery_recovery_actions_id_seq') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE public.clinical_alert_delivery_recovery_actions_id_seq FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT USAGE, SELECT ON SEQUENCE public.clinical_alert_delivery_recovery_actions_id_seq TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.pharmacy_counter_sale_void_requests_id_seq') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE public.pharmacy_counter_sale_void_requests_id_seq FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT USAGE, SELECT ON SEQUENCE public.pharmacy_counter_sale_void_requests_id_seq TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.billing_refund_offline_electronic_evidence_id_seq') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE public.billing_refund_offline_electronic_evidence_id_seq FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT USAGE, SELECT ON SEQUENCE public.billing_refund_offline_electronic_evidence_id_seq TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.billing_refunds_id_seq') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE public.billing_refunds_id_seq FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT USAGE, SELECT ON SEQUENCE public.billing_refunds_id_seq TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regclass('public.cash_drawer_sessions_id_seq') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON SEQUENCE public.cash_drawer_sessions_id_seq FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT USAGE, SELECT ON SEQUENCE public.cash_drawer_sessions_id_seq TO %I',
          '${role}'
        );
      END IF;
      FOREACH med03_trigger_function IN ARRAY med03_trigger_functions
      LOOP
        IF pg_catalog.to_regprocedure(
          pg_catalog.format('public.%I()', med03_trigger_function)
        ) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',
            med03_trigger_function,
            '${role}'
          );
        END IF;
      END LOOP;
      IF pg_catalog.to_regprocedure('public.counter_sale_void_has_paid_evidence(bigint)') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_has_paid_evidence(BIGINT) FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION public.counter_sale_void_has_paid_evidence(BIGINT) TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.mar_supply_batch_unavailable_reason(text,text,date,numeric,timestamp with time zone)'
      ) IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION public.mar_supply_batch_unavailable_reason(TEXT, TEXT, DATE, NUMERIC, TIMESTAMPTZ) TO %I',
          '${role}'
        );
      END IF;
      IF pg_catalog.to_regprocedure('public.cath_inventory_shortfall_assert_contract(uuid,bigint)') IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) FROM %I',
          '${role}'
        );
        EXECUTE pg_catalog.format(
          'GRANT EXECUTE ON FUNCTION public.cath_inventory_shortfall_assert_contract(UUID, BIGINT) TO %I',
          '${role}'
        );
      END IF;
      FOREACH med03_runtime_wrapper_function IN ARRAY med03_runtime_wrapper_functions
      LOOP
        IF pg_catalog.to_regprocedure(
          pg_catalog.format('public.%s', med03_runtime_wrapper_function)
        ) IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON FUNCTION public.%s FROM %I',
            med03_runtime_wrapper_function,
            '${role}'
          );
          EXECUTE pg_catalog.format(
            'GRANT EXECUTE ON FUNCTION public.%s TO %I',
            med03_runtime_wrapper_function,
            '${role}'
          );
        END IF;
      END LOOP;
      -- Migration 631 intentionally exposes this append-only receipt through
      -- column-scoped INSERT only. Reapply that fence after every broad grant.
      IF pg_catalog.to_regclass('public.hl7_inbound_recovery_receipts') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON TABLE public.hl7_inbound_recovery_receipts
          FROM ${role};
        GRANT SELECT
          ON TABLE public.hl7_inbound_recovery_receipts
          TO ${role};
        GRANT INSERT (
          id, tenant_id, recovery_inbox_id, interface_family,
          signing_credential_id, source_partition, generation, source_position,
          source_token, predecessor_token, duplicate_key, message_family,
          message_type, trigger_event, message_control_id_sha256,
          payload_ciphertext, payload_sha256, payload_bytes, source_observed_at,
          source_received_at, clock_evidence, patient_uid,
          visit_identity_sha256, order_identity_sha256, pending_task_id,
          review_role, status, outcome_code, ack_ciphertext, ack_sha256,
          ack_bytes, ack_code, http_status, policy_version, policy_signature,
          retention_policy, retention_until
        ) ON TABLE public.hl7_inbound_recovery_receipts TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public.hl7_inbound_recovery_receipts_id_seq') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON SEQUENCE public.hl7_inbound_recovery_receipts_id_seq
          FROM ${role};
        GRANT USAGE, SELECT
          ON SEQUENCE public.hl7_inbound_recovery_receipts_id_seq
          TO ${role};
      END IF;
      -- Migration 656 receipts and resource links are append-only. The set
      -- row permits only the fenced claim/link/completion state transitions.
      IF pg_catalog.to_regclass('public.fhir_vital_observation_receipts') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON TABLE public.fhir_vital_observation_receipts
          FROM ${role};
        GRANT SELECT, INSERT
          ON TABLE public.fhir_vital_observation_receipts
          TO ${role};
        GRANT UPDATE (patient_uid)
          ON TABLE public.fhir_vital_observation_receipts
          TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public.fhir_vital_observation_sets') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON TABLE public.fhir_vital_observation_sets
          FROM ${role};
        GRANT SELECT, INSERT
          ON TABLE public.fhir_vital_observation_sets
          TO ${role};
        GRANT UPDATE (
          patient_uid,
          vitals_chart_id,
          news2_effects_completed_at,
          anomaly_effects_completed_at,
          news2_effects_claimed_at,
          news2_effects_claim_token,
          news2_effects_attempts,
          news2_effects_next_retry_at,
          anomaly_effects_claimed_at,
          anomaly_effects_claim_token,
          anomaly_effects_attempts,
          anomaly_effects_next_retry_at
        ) ON TABLE public.fhir_vital_observation_sets TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public.fhir_vital_observation_set_resources') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON TABLE public.fhir_vital_observation_set_resources
          FROM ${role};
        GRANT SELECT, INSERT
          ON TABLE public.fhir_vital_observation_set_resources
          TO ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.validate_fhir_vital_observation_receipt_update()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.validate_fhir_vital_observation_receipt_update()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.validate_fhir_vital_observation_receipt_scope_deferred()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.validate_fhir_vital_observation_receipt_scope_deferred()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.validate_fhir_vital_observation_set_link()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.validate_fhir_vital_observation_set_link()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.validate_fhir_vital_observation_set_scope_deferred()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.validate_fhir_vital_observation_set_scope_deferred()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.validate_fhir_vital_observation_resource_owner()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.validate_fhir_vital_observation_resource_owner()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regclass('public.clinical_continuity_policy_versions') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
          ON TABLE public.clinical_continuity_policy_versions
          FROM ${role};
      END IF;
      IF pg_catalog.to_regclass('public.downtime_snapshots') IS NOT NULL THEN
        REVOKE UPDATE, TRUNCATE
          ON TABLE public.downtime_snapshots
          FROM ${role};
      END IF;
      IF pg_catalog.to_regclass('public.downtime_snapshots_id_seq') IS NOT NULL THEN
        REVOKE UPDATE
          ON SEQUENCE public.downtime_snapshots_id_seq
          FROM ${role};
      END IF;
      IF pg_catalog.to_regclass('public.clinical_continuity_manifest_version_seq') IS NOT NULL THEN
        REVOKE UPDATE
          ON SEQUENCE public.clinical_continuity_manifest_version_seq
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_parse_timestamp(text)'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_parse_timestamp(text)
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_policy_guard_version()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_policy_guard_version()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_assert_policy_approval(uuid,uuid)'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_assert_policy_approval(uuid, uuid)
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_policy_approval_constraint()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_policy_approval_constraint()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_policy_guard_lifecycle()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_policy_guard_lifecycle()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_block_approval_mutation()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_block_approval_mutation()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_assert_snapshot_governance()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_assert_snapshot_governance()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_snapshot_guard_mutation()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_snapshot_guard_mutation()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.clinical_continuity_purge_snapshot_payload(uuid,integer,integer,text)'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_purge_snapshot_payload(
            uuid, integer, integer, text
          )
          FROM ${role};
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'object grants for ${role} skipped (executing role lacks privilege on some objects)';
    END;
    BEGIN
      -- Migrations 601/604 keep continuity capture issuance inert while C-D14
      -- is open. Rebuild their column ACLs after the broad startup grant so a
      -- later role reconciliation cannot silently reactivate capture authority.
      IF pg_catalog.to_regclass('public.clinical_continuity_edge_access_grants') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
          ON TABLE public.clinical_continuity_edge_access_grants
          FROM ${role};
        GRANT SELECT
          ON TABLE public.clinical_continuity_edge_access_grants
          TO ${role};
        GRANT INSERT (
          tenant_id, facility_id, location_type, location_identifier,
          staff_uid, device_id, client_certificate_sha256,
          valid_from, valid_until, policy_version_id, policy_version,
          created_by
        ) ON TABLE public.clinical_continuity_edge_access_grants TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public.clinical_continuity_edge_access_revocations') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
          ON TABLE public.clinical_continuity_edge_access_revocations
          FROM ${role};
        GRANT SELECT
          ON TABLE public.clinical_continuity_edge_access_revocations
          TO ${role};
        GRANT INSERT (
          tenant_id, facility_id, grant_id, revoked_by, reason
        ) ON TABLE public.clinical_continuity_edge_access_revocations TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public.clinical_continuity_edge_log_receipts') IS NOT NULL THEN
        REVOKE INSERT, UPDATE, DELETE, TRUNCATE
          ON TABLE public.clinical_continuity_edge_log_receipts
          FROM ${role};
        GRANT SELECT
          ON TABLE public.clinical_continuity_edge_log_receipts
          TO ${role};
        GRANT INSERT (
          tenant_id, facility_id, device_id, grant_id,
          client_certificate_sha256, policy_version_id, policy_version,
          access_revision, batch_id, previous_batch_sha256, batch_sha256,
          event_count, first_event_sequence, last_event_sequence,
          first_event_at, last_event_at, signature_algorithm,
          signature_sha256, imported_by
        ) ON TABLE public.clinical_continuity_edge_log_receipts TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public.clinical_continuity_edge_access_revision_seq') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON SEQUENCE public.clinical_continuity_edge_access_revision_seq
          FROM ${role};
        GRANT USAGE, SELECT
          ON SEQUENCE public.clinical_continuity_edge_access_revision_seq
          TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public.clinical_continuity_capture_revision_seq') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON SEQUENCE public.clinical_continuity_capture_revision_seq
          FROM ${role};
      END IF;
      IF pg_catalog.to_regclass('public.clinical_continuity_context_revision_seq') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON SEQUENCE public.clinical_continuity_context_revision_seq
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure('public.clinical_continuity_edge_block_mutation()') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_edge_block_mutation()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure('public.clinical_continuity_fixed_device_no_overlap()') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.clinical_continuity_fixed_device_no_overlap()
          FROM ${role};
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'continuity capture lock for ${role} skipped (insufficient privilege)';
    END;
    BEGIN
      IF pg_catalog.to_regprocedure(
        'public.hl7_i03_length_prefixed_sha256(text[])'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.hl7_i03_length_prefixed_sha256(text[])
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.assert_hl7_inbound_recovery_task(uuid,integer,bigint,uuid,uuid,text)'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.assert_hl7_inbound_recovery_task(
            uuid, integer, bigint, uuid, uuid, text
          )
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.validate_hl7_inbound_recovery_receipt()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.validate_hl7_inbound_recovery_receipt()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.validate_hl7_inbound_recovery_convergence()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.validate_hl7_inbound_recovery_convergence()
          FROM ${role};
      END IF;
      IF pg_catalog.to_regprocedure(
        'public.hl7_inbound_recovery_receipt_append_only()'
      ) IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.hl7_inbound_recovery_receipt_append_only()
          FROM ${role};
      END IF;
    EXCEPTION WHEN insufficient_privilege OR undefined_function THEN
      RAISE NOTICE 'I03 recovery function revokes for ${role} skipped';
    END;
    BEGIN
      IF pg_catalog.to_regclass('public._migrations') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON TABLE public._migrations
          FROM ${role};
        GRANT SELECT
          ON TABLE public._migrations
          TO ${role};
      END IF;
      IF pg_catalog.to_regclass('public._migrations_id_seq') IS NOT NULL THEN
        REVOKE ALL PRIVILEGES
          ON SEQUENCE public._migrations_id_seq
          FROM ${role};
      END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'migration tracker read-only fence for ${role} skipped (insufficient privilege)';
    END;
    BEGIN
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE ON SCHEMA public FROM ${role};
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'public schema CREATE revoke for ${role} skipped (insufficient privilege)';
    END;
    IF pg_catalog.to_regprocedure('public.pathway_projector_enqueue_new_event()') IS NOT NULL THEN
      BEGIN
        REVOKE ALL PRIVILEGES
          ON FUNCTION public.pathway_projector_enqueue_new_event()
          FROM ${role};
      EXCEPTION WHEN insufficient_privilege OR undefined_function THEN
        RAISE NOTICE 'pathway projector trigger-function revoke for ${role} skipped';
      END;
    END IF;
  END IF;
END
$$;`;
  try {
    await prisma.$executeRawUnsafe(sql);
    logger.info('Tenant RLS runtime role grants ensured', { role });
    return { skipped: false, role };
  } catch (err) {
    const fundingAclFailure = err?.meta?.code === 'V7530'
      || err?.code === 'V7530'
      || String(err?.message || '').includes(
        'migration-753 protected runtime ACL reconciliation failed',
      );
    if (fundingAclFailure) {
      logger.error(
        'Migration-753 protected runtime ACL reconciliation failed — refusing startup',
        { role, message: err?.message },
      );
      throw err;
    }
    logger.warn('Tenant RLS runtime role grant pass failed (startup continues; tenant-scoped queries will fail closed if the role is unusable)', {
      role,
      message: err?.message,
    });
    return { skipped: false, role, error: err?.message };
  }
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
