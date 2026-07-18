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
 *   - Prisma 7 driver adapter       → err.meta.driverAdapterError.cause.originalCode
 *   - Wrapped-error fallback        → err.code (raw pg error)
 */
function isIgnoredBreakerError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = err?.meta?.code ||
    err?.meta?.driverAdapterError?.cause?.originalCode ||
    err?.code;
  return typeof code === 'string' && BREAKER_IGNORED_PG_ERROR_CODES.has(code);
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

function makeClient(url, tag, { statementTimeoutMs = 0 } = {}) {
  if (!url) {
    throw new Error(`DATABASE_URL is required to create Prisma[${tag}] client`);
  }
  const connectionString = applyStatementTimeoutToUrl(url, statementTimeoutMs);
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
      const result = await fn.apply(this, args);
      breaker.consecutiveFailures = 0;
      return result;
    } catch (err) {
      // Known-bad-query errors (relation/schema not found, undefined column,
      // etc.) are not infrastructure failures — the driver is healthy, the
      // query just doesn't match the current schema. Re-throw so the caller
      // can handle it, but don't count it toward the breaker budget.
      // Without this, a brief migration window or qa-reset DROP SCHEMA can
      // latch the breaker open for 30s after the schema is already healthy.
      if (isIgnoredBreakerError(err)) {
        // WS2 / REL-5: a Postgres 42P01 (undefined_table) specifically means a
        // graceful fallback path is being exercised (missing-table read during a
        // migration window, a partition the downtime mirror papers over, etc.).
        // Scope this to EXACTLY 42P01 — NOT the whole ignored set (42703 column,
        // 3F000 schema, … are different signals) — so the named metric + warn
        // track only the undefined_table fallback. Reuse extractSqlState rather
        // than re-deriving the SQLSTATE. The error is still re-thrown unchanged.
        if (extractSqlState(err) === '42P01') {
          recordUndefinedTableFallback();
          logger.warn('Postgres 42P01 (undefined_table) — graceful fallback path', {
            message: String(err?.message || '').slice(0, 200),
          });
        }
        throw err;
      }
      breaker.consecutiveFailures += 1;
      if (breaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        breaker.circuitOpen = true;
        breaker.circuitOpenedAt = Date.now();
        logger.error(
          `Prisma[${tag}] circuit breaker OPEN after ${breaker.consecutiveFailures} consecutive failures`,
        );
      }
      throw err;
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
function runTenantScopedTransaction(client, gucValue, fn, transactionOptions = undefined) {
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
    return fn(tx);
  };
  return transactionOptions
    ? client.$transaction(transaction, transactionOptions)
    : client.$transaction(transaction);
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
 */
export async function setTenantTx(
  tenantId,
  fn,
  { superAdmin = false, readOnly = false, isolationLevel = undefined } = {},
) {
  if (!superAdmin && !tenantId) {
    throw new Error('setTenantTx requires tenantId (or { superAdmin: true } to bypass)');
  }
  const gucValue = superAdmin ? 'bypass' : tenantId;
  const client = pickTenantClient({ readOnly });

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
      isolationLevel ? { isolationLevel } : undefined,
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
export function evaluateTenantRlsPosture({
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
             )) AS unforced_owned_rls_tables`,
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
 * a misconfigured deployment can't silently ship inert isolation. Best-effort
 * — never throws, never blocks startup.
 */
export async function logTenantRlsRolePosture() {
  const posture = await tenantRlsRolePosture();
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
  });
  return posture;
}

/**
 * CAN-040: decide whether an unsafe tenant-RLS posture must FAIL CLOSED at boot.
 * Production refuses to start when RLS is disabled (`!enforced`) or inert
 * (`!ok` — effective role bypasses RLS / owns unforced policy tables) so a
 * misconfigured deployment can't silently serve PHI with isolation off. A
 * probe error is not treated as fatal (it is logged as a warning). An explicit,
 * audited override (`AUTH_TENANT_RLS_FAIL_OPEN=true`) is honoured for a
 * confirmed single-tenant maintenance window. Non-production never fails closed.
 * Pure + env-injectable so the boot guard is unit-testable.
 */
export function tenantRlsPostureMustFailClosed(posture, env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() !== 'production') return false;
  if (String(env.AUTH_TENANT_RLS_FAIL_OPEN || '').toLowerCase() === 'true') return false;
  if (!posture || posture.error) return false;
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
 * Every statement is tolerant: missing CREATEROLE privilege downgrades to a
 * NOTICE and the grants still run (the table owner can always GRANT on the
 * objects it owns). Failure never blocks startup — SET LOCAL ROLE to a role
 * lacking privileges fails CLOSED (queries error loudly rather than leak).
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
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    BEGIN
      CREATE ROLE ${role} NOLOGIN;
      ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'cannot CREATE ROLE ${role} (no CREATEROLE) — expecting it to be provisioned externally (CNPG managed.roles)';
    END;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${role}', current_database());
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role};
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'object grants for ${role} skipped (executing role lacks privilege on some objects)';
    END;
    BEGIN
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO ${role};
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'default-privilege grants for ${role} skipped (insufficient privilege)';
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
