// src/tests/unit/prismaHardening.test.js
// Unit tests for src/lib/prisma.js hardening:
//   - Circuit breaker opens after N consecutive failures
//   - Circuit breaker stays open for RESET_MS, then half-opens
//   - setTenant wraps a Prisma $transaction with set_config(...) of the GUC
//   - prismaReadOnly falls back to primary when DATABASE_READ_URL unset
//
// We mock @prisma/client so the PrismaClient constructor returns a stub
// whose $queryRaw/$queryRawUnsafe/$transaction we can control. No real DB
// connection is opened.

import { jest } from '@jest/globals';
import { AppError } from '../../utils/AppError.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: mockLogger }));

// PrismaClient stub — the test overrides per-instance methods as needed.
class PrismaClientStub {
  constructor(_opts) {
    this._handlers = new Map();
    // Default no-op raw methods — per-test override via overrideRaw().
    this.$queryRaw = jest.fn(async () => []);
    this.$queryRawUnsafe = jest.fn(async () => []);
    this.$executeRaw = jest.fn(async () => 0);
    this.$executeRawUnsafe = jest.fn(async () => 0);
    this.$transaction = jest.fn(async (cb) => {
      if (typeof cb === 'function') return cb(this);
      return cb;
    });
    this.$disconnect = jest.fn(async () => {});
    this.$on = jest.fn((level, handler) => this._handlers.set(level, handler));
  }
}

jest.unstable_mockModule('@prisma/client', () => ({ PrismaClient: PrismaClientStub }));

// ── Tests ──────────────────────────────────────────────────────────────

describe('src/lib/prisma.js hardening', () => {
  let prismaModule;
  let metricsModule;

  beforeEach(async () => {
    jest.resetModules();
    // Ensure read-replica env var is unset for the primary-fallback test;
    // specific tests re-import after setting it to true.
    delete process.env.DATABASE_READ_URL;
    process.env.DATABASE_URL = 'postgresql://test@localhost/test';
    prismaModule = await import('../../lib/prisma.js');
    // prometheusMiddleware.js is NOT mocked — prisma.js imports the real
    // recordUndefinedTableFallback from it. After jest.resetModules() this is a
    // fresh module instance (counter starts at 0), and because the dynamic
    // import below resolves through the same post-reset registry it is the SAME
    // instance prisma.js incremented. Lets each test assert a clean delta.
    metricsModule = await import('../../middleware/prometheusMiddleware.js');
    prismaModule.__resetCircuitBreakerForTests();
    jest.clearAllMocks();
  });

  // Count occurrences of the named 42P01 fallback series in the exposition output.
  function undefinedTableFallbackCount() {
    const out = metricsModule.serializeMetrics();
    // The counter has no labels, so the exposition value line is
    // `db_undefined_table_fallback_total N` (no `{...}`). Match the value line in
    // either labeled or unlabeled form, excluding the `# HELP`/`# TYPE` lines.
    const line = out
      .split('\n')
      .find((l) => /^db_undefined_table_fallback_total[ {]/.test(l));
    if (!line) return 0;
    return Number(line.trim().split(/\s+/).pop()) || 0;
  }

  // ── Circuit breaker ───────────────────────────────────────────────────

  describe('circuit breaker', () => {
    it('starts closed with zero failures', () => {
      const status = prismaModule.circuitBreakerStatus();
      expect(status.open).toBe(false);
      expect(status.consecutiveFailures).toBe(0);
    });

    it('opens after 5 consecutive $queryRawUnsafe failures', async () => {
      const prisma = prismaModule.default;
      // Force the underlying mock to reject so the wrapper sees failures.
      // Calling through the proxy invokes `get` → returns the wrapped method.
      // We attack the underlying function via a spy on the proxy target.
      const boom = () => Promise.reject(new Error('boom'));
      // The Proxy forwards `$queryRawUnsafe` to the base target — replace
      // the base target's method so the wrapper sees the rejection.
      Object.getPrototypeOf(prisma); // force Proxy resolution
      // Since we don't have direct access to the target, exercise failures
      // through the public surface: rebind the mock to always throw.
      // PrismaClientStub instances are constructed inside the module, so we
      // reach in via the shared lib cache.
      const primaryStub = await getPrimaryStub(prismaModule);
      primaryStub.$queryRawUnsafe = jest.fn(boom);

      for (let i = 0; i < 5; i += 1) {
        await expect(prisma.$queryRawUnsafe('SELECT 1')).rejects.toThrow('boom');
      }

      const status = prismaModule.circuitBreakerStatus();
      expect(status.open).toBe(true);
      expect(status.consecutiveFailures).toBe(5);
      // Next call short-circuits without invoking the underlying method.
      primaryStub.$queryRawUnsafe.mockClear();
      await expect(prisma.$queryRawUnsafe('SELECT 2')).rejects.toThrow(
        /Database circuit breaker is open/,
      );
      expect(primaryStub.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('does not count application errors thrown by interactive transaction callbacks', async () => {
      const notFound = AppError.notFound('Care pathway instance');

      for (let i = 0; i < 10; i += 1) {
        await expect(
          prismaModule.setTenant(TENANT_ID, async () => {
            throw notFound;
          }),
        ).rejects.toBe(notFound);
      }

      expect(prismaModule.circuitBreakerStatus()).toMatchObject({
        open: false,
        consecutiveFailures: 0,
      });
    });

    it('does not count plain business errors thrown by interactive transaction callbacks', async () => {
      const businessError = new Error('Pathway transition is not allowed');

      for (let i = 0; i < 6; i += 1) {
        await expect(
          prismaModule.setTenant(TENANT_ID, async () => {
            throw businessError;
          }),
        ).rejects.toBe(businessError);
      }

      expect(prismaModule.circuitBreakerStatus()).toMatchObject({
        open: false,
        consecutiveFailures: 0,
      });
    });

    it('resets an infrastructure-failure streak after a callback business error', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);
      const infrastructureError = new Error('transient infrastructure failure');
      primaryStub.$queryRawUnsafe = jest.fn().mockRejectedValue(infrastructureError);

      for (let i = 0; i < 4; i += 1) {
        await expect(prisma.$queryRawUnsafe('SELECT 1')).rejects.toBe(infrastructureError);
      }
      expect(prismaModule.circuitBreakerStatus().consecutiveFailures).toBe(4);

      primaryStub.$queryRawUnsafe = jest.fn().mockResolvedValue([]);
      const notFound = AppError.notFound('Care pathway instance');
      await expect(
        prismaModule.setTenant(TENANT_ID, async () => {
          throw notFound;
        }),
      ).rejects.toBe(notFound);
      expect(prismaModule.circuitBreakerStatus()).toMatchObject({
        open: false,
        consecutiveFailures: 0,
      });

      primaryStub.$queryRawUnsafe = jest.fn().mockRejectedValue(infrastructureError);
      await expect(prisma.$queryRawUnsafe('SELECT 1')).rejects.toBe(infrastructureError);
      expect(prismaModule.circuitBreakerStatus()).toMatchObject({
        open: false,
        consecutiveFailures: 1,
      });
    });

    it('still counts infrastructure errors raised inside interactive transaction callbacks', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);
      const timeoutError = Object.assign(new Error('Timed out while acquiring a connection'), {
        code: 'P1008',
      });

      primaryStub.$transaction = jest.fn(async (callback) => {
        const tx = new PrismaClientStub();
        tx.$queryRawUnsafe = jest.fn().mockRejectedValue(timeoutError);
        return callback(tx);
      });

      for (let i = 0; i < 5; i += 1) {
        await expect(prisma.$transaction(async (tx) => tx.$queryRawUnsafe('SELECT 1'))).rejects.toBe(
          timeoutError,
        );
      }

      expect(prismaModule.circuitBreakerStatus()).toMatchObject({
        open: true,
        consecutiveFailures: 5,
      });
    });

    it('still counts infrastructure failures that prevent an interactive transaction from starting', async () => {
      const primaryStub = await getPrimaryStub(prismaModule);
      const connectionError = Object.assign(new Error('Connection refused'), {
        code: 'ECONNREFUSED',
      });

      primaryStub.$transaction = jest.fn().mockRejectedValue(connectionError);

      for (let i = 0; i < 5; i += 1) {
        await expect(
          prismaModule.setTenant(TENANT_ID, async () => 'never reached'),
        ).rejects.toBe(connectionError);
      }

      expect(prismaModule.circuitBreakerStatus()).toMatchObject({
        open: true,
        consecutiveFailures: 5,
      });
    });

    it('successful call resets the failure counter', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      primaryStub.$queryRawUnsafe = jest.fn()
        .mockRejectedValueOnce(new Error('x'))
        .mockRejectedValueOnce(new Error('x'))
        .mockResolvedValueOnce([{ ok: true }]);

      await expect(prisma.$queryRawUnsafe('a')).rejects.toThrow();
      await expect(prisma.$queryRawUnsafe('b')).rejects.toThrow();
      expect(prismaModule.circuitBreakerStatus().consecutiveFailures).toBe(2);

      const rows = await prisma.$queryRawUnsafe('c');
      expect(rows).toEqual([{ ok: true }]);
      expect(prismaModule.circuitBreakerStatus().consecutiveFailures).toBe(0);
    });

    // Regression test for docs/qa-findings/2026-05-08-backend-circuit-
    // breaker-trips-during-qa-reset-schema-drop.md.
    //
    // During qa-reset's `DROP SCHEMA public CASCADE` window, any in-flight
    // backend query hits a partially-rebuilt schema and surfaces Postgres
    // 42P01 (relation does not exist). Those errors are not infra failures
    // — they're known-bad queries against a transient schema state — and
    // must not count toward the breaker's failure budget, otherwise a
    // brief migration window latches the breaker open for 30s after the
    // schema is healthy again.
    it('does not count Postgres 42P01 (undefined_table) toward breaker budget', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      const schemaErr = Object.assign(new Error('relation "users" does not exist'), {
        meta: { code: '42P01' },
      });
      primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(schemaErr));

      // Ten such errors — far above the threshold — must not open the breaker.
      for (let i = 0; i < 10; i += 1) {
        await expect(prisma.$queryRawUnsafe('SELECT 1 FROM users')).rejects.toBe(schemaErr);
      }

      const status = prismaModule.circuitBreakerStatus();
      expect(status.open).toBe(false);
      expect(status.consecutiveFailures).toBe(0);
    });

    it('also ignores 3F000 (invalid_schema_name) and err.code fallback', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      // Some Prisma errors surface SQLSTATE on err.code rather than err.meta.code.
      const schemaErr = Object.assign(new Error('schema "public" does not exist'), {
        code: '3F000',
      });
      primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(schemaErr));

      for (let i = 0; i < 10; i += 1) {
        await expect(prisma.$queryRawUnsafe('SELECT 1')).rejects.toBe(schemaErr);
      }

      expect(prismaModule.circuitBreakerStatus().consecutiveFailures).toBe(0);
    });

    it.each(['23503', '23514'])(
      'does not count deterministic Postgres %s integrity rejections as infrastructure failures',
      async (code) => {
        const prisma = prismaModule.default;
        const primaryStub = await getPrimaryStub(prismaModule);
        const integrityErr = Object.assign(new Error('constraint rejected the write'), {
          meta: { code },
        });
        primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(integrityErr));

        for (let i = 0; i < 10; i += 1) {
          await expect(prisma.$queryRawUnsafe('INSERT invalid')).rejects.toBe(integrityErr);
        }

        expect(prismaModule.circuitBreakerStatus()).toMatchObject({
          open: false,
          consecutiveFailures: 0,
        });
      },
    );

    it('resets an infrastructure-failure streak after an ignored integrity rejection', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);
      const infrastructureError = new Error('transient infrastructure failure');
      primaryStub.$queryRawUnsafe = jest.fn().mockRejectedValue(infrastructureError);

      for (let i = 0; i < 4; i += 1) {
        await expect(prisma.$queryRawUnsafe('SELECT 1')).rejects.toBe(infrastructureError);
      }
      expect(prismaModule.circuitBreakerStatus().consecutiveFailures).toBe(4);

      const integrityError = Object.assign(new Error('constraint rejected the write'), {
        meta: { code: '23514' },
      });
      primaryStub.$queryRawUnsafe = jest.fn().mockRejectedValue(integrityError);
      await expect(prisma.$queryRawUnsafe('INSERT invalid')).rejects.toBe(integrityError);
      expect(prismaModule.circuitBreakerStatus()).toMatchObject({
        open: false,
        consecutiveFailures: 0,
      });

      primaryStub.$queryRawUnsafe = jest.fn().mockRejectedValue(infrastructureError);
      await expect(prisma.$queryRawUnsafe('SELECT 1')).rejects.toBe(infrastructureError);
      expect(prismaModule.circuitBreakerStatus()).toMatchObject({
        open: false,
        consecutiveFailures: 1,
      });
    });

    it('ignores Prisma 7 driver adapter SQLSTATE metadata', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      const schemaErr = Object.assign(new Error('relation "clinical_ai_runs" does not exist'), {
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: '42P01',
              originalMessage: 'relation "clinical_ai_runs" does not exist',
            },
          },
        },
      });
      primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(schemaErr));

      for (let i = 0; i < 10; i += 1) {
        await expect(prisma.$queryRawUnsafe('SELECT 1 FROM clinical_ai_runs')).rejects.toBe(schemaErr);
      }

      expect(prismaModule.circuitBreakerStatus().open).toBe(false);
      expect(prismaModule.circuitBreakerStatus().consecutiveFailures).toBe(0);
    });

    it('mixed ignored and infra failures: ignored errors reset the streak', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      const schemaErr = Object.assign(new Error('no table'), { meta: { code: '42P01' } });
      const infraErr = new Error('connection refused');

      primaryStub.$queryRawUnsafe = jest.fn()
        .mockRejectedValueOnce(schemaErr)
        .mockRejectedValueOnce(infraErr)
        .mockRejectedValueOnce(schemaErr)
        .mockRejectedValueOnce(infraErr);

      for (let i = 0; i < 4; i += 1) {
        await expect(prisma.$queryRawUnsafe('q')).rejects.toThrow();
      }

      // Each ignored rejection proves the database is reachable and breaks the
      // infrastructure-failure streak, leaving only the final failure counted.
      expect(prismaModule.circuitBreakerStatus().consecutiveFailures).toBe(1);
      expect(prismaModule.circuitBreakerStatus().open).toBe(false);
    });
  });

  // ── 42P01 graceful-fallback metric (WS2 / REL-5) ─────────────────────
  //
  // A Postgres 42P01 (undefined_table) re-thrown by the breaker must ALSO
  // bump the named db_undefined_table_fallback_total counter and warn, so an
  // outage/migration fallback path is observable. Other ignored SQLSTATEs
  // (3F000 schema, 42703 column) and real infra errors must NOT bump it.
  describe('db_undefined_table_fallback_total counter', () => {
    it('increments on a simulated 42P01 and the metric is exposed', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      const before = undefinedTableFallbackCount();
      const schemaErr = Object.assign(new Error('relation "wards" does not exist'), {
        meta: { code: '42P01' },
      });
      primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(schemaErr));

      await expect(prisma.$queryRawUnsafe('SELECT 1 FROM wards')).rejects.toBe(schemaErr);

      expect(undefinedTableFallbackCount()).toBe(before + 1);
      // The named series must be present in the exposition output at all.
      expect(metricsModule.serializeMetrics()).toContain('db_undefined_table_fallback_total');
      // And it warns on the fallback path.
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Postgres 42P01 (undefined_table) — graceful fallback path',
        expect.objectContaining({ message: expect.any(String) }),
      );
    });

    it('also increments on a 42P01 surfaced via the Prisma 7 driver adapter', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      const before = undefinedTableFallbackCount();
      const schemaErr = Object.assign(new Error('relation "beds" does not exist'), {
        meta: { driverAdapterError: { cause: { originalCode: '42P01' } } },
      });
      primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(schemaErr));

      await expect(prisma.$queryRawUnsafe('SELECT 1 FROM beds')).rejects.toBe(schemaErr);

      expect(undefinedTableFallbackCount()).toBe(before + 1);
    });

    it('does NOT increment on 3F000 (invalid_schema_name)', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      const before = undefinedTableFallbackCount();
      const schemaErr = Object.assign(new Error('schema "public" does not exist'), {
        code: '3F000',
      });
      primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(schemaErr));

      await expect(prisma.$queryRawUnsafe('SELECT 1')).rejects.toBe(schemaErr);

      expect(undefinedTableFallbackCount()).toBe(before);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Postgres 42P01 (undefined_table) — graceful fallback path',
        expect.anything(),
      );
    });

    it('does NOT increment on 42703 (undefined_column)', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      const before = undefinedTableFallbackCount();
      const colErr = Object.assign(new Error('column "foo" does not exist'), {
        meta: { code: '42703' },
      });
      primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(colErr));

      await expect(prisma.$queryRawUnsafe('SELECT foo FROM users')).rejects.toBe(colErr);

      expect(undefinedTableFallbackCount()).toBe(before);
    });

    it('does NOT increment on an infrastructure error (e.g. connection refused)', async () => {
      const prisma = prismaModule.default;
      const primaryStub = await getPrimaryStub(prismaModule);

      const before = undefinedTableFallbackCount();
      const infraErr = new Error('connection refused');
      primaryStub.$queryRawUnsafe = jest.fn(() => Promise.reject(infraErr));

      await expect(prisma.$queryRawUnsafe('SELECT 1')).rejects.toBe(infraErr);

      expect(undefinedTableFallbackCount()).toBe(before);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Postgres 42P01 (undefined_table) — graceful fallback path',
        expect.anything(),
      );
    });
  });

  // ── setTenant RLS helper ─────────────────────────────────────────────

  describe('setTenant', () => {
    it('rejects when tenantId is missing and superAdmin is false', async () => {
      await expect(
        prismaModule.setTenant(null, async () => 'nope'),
      ).rejects.toThrow(/requires tenantId/);
    });

    it('wraps fn in a transaction that issues set_config with the tenantId', async () => {
      const primaryStub = await getPrimaryStub(prismaModule);
      const tx = new PrismaClientStub();
      tx.$queryRawUnsafe = jest.fn(async () => []);
      primaryStub.$transaction = jest.fn(async (cb) => cb(tx));

      const tenantUid = '11111111-2222-3333-4444-555555555555';
      const result = await prismaModule.setTenant(tenantUid, async (client) => {
        expect(prismaModule.isTenantTransactionClient(client)).toBe(true);
        await client.$queryRawUnsafe('SELECT 1');
        return 'returned';
      });

      expect(result).toBe('returned');
      expect(tx.$queryRawUnsafe).toHaveBeenNthCalledWith(
        1,
        "SELECT set_config('app.current_tenant_id', $1, true)",
        tenantUid,
      );
      expect(tx.$queryRawUnsafe).toHaveBeenNthCalledWith(2, 'SELECT 1');
      expect(prismaModule.isTenantTransactionClient(tx)).toBe(true);
      expect(prismaModule.isTenantTransactionClient(primaryStub)).toBe(false);
      expect(prismaModule.isTenantTransactionClient({})).toBe(false);
      expect(prismaModule.isTenantTransactionClient(null)).toBe(false);
    });

    it('uses "bypass" as GUC value when superAdmin is true', async () => {
      const primaryStub = await getPrimaryStub(prismaModule);
      const tx = new PrismaClientStub();
      tx.$queryRawUnsafe = jest.fn(async () => []);
      primaryStub.$transaction = jest.fn(async (cb) => cb(tx));

      await prismaModule.setTenant(null, async () => 'ok', { superAdmin: true });

      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        'bypass',
      );
    });
  });

  // ── Read replica ─────────────────────────────────────────────────────

  describe('prismaReadOnly', () => {
    it('is the same instance as primary when DATABASE_READ_URL is unset', () => {
      // Set up in beforeEach above (env var unset); re-assert here.
      expect(prismaModule.prismaReadOnly).toBe(prismaModule.default);
    });

    it('is a distinct instance when DATABASE_READ_URL is set', async () => {
      jest.resetModules();
      process.env.DATABASE_READ_URL = 'postgresql://test@replica/test';
      const freshModule = await import('../../lib/prisma.js');
      expect(freshModule.prismaReadOnly).not.toBe(freshModule.default);
      delete process.env.DATABASE_READ_URL;
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────

// Reach into the module to get the underlying PrismaClientStub instance the
// Proxy wraps. We do this by invoking a non-wrapped property — $on is on the
// base client and returns the stub itself via our mock.
async function getPrimaryStub(mod) {
  // The proxy forwards any property that isn't in WRAPPED_METHODS straight
  // through, so `prisma.$on` returns the bound $on of the base client.
  // To mutate the underlying $queryRawUnsafe, we need the base object.
  // The Proxy `get` trap binds methods to the target — but returns the
  // target's own properties untouched for non-functions. We dig via
  // a trick: read a sentinel property that returns `this`.
  const proxy = mod.default;
  // Use the transaction mock to surface the underlying `this`:
  let captured;
  const originalTx = proxy.$transaction;
  // $transaction is wrapped — but the wrapper calls fn.apply(this, args),
  // and `this` inside the wrapper is the base target. We capture via a
  // one-shot $transaction(cb → captured = this).
  // Easier: just use an internal hook. We override via the base client
  // using its $on spy which proxy forwards as-is (non-wrapped method).
  const baseOnFn = proxy.$on;
  // The bound $on's `this` IS the base client, but we can't read this
  // without calling it. Register a dummy listener to capture the this.
  const handlerId = { captured: null };
  proxy.$on.call = function (ctx, ...a) { handlerId.captured = ctx; return Function.prototype.call.apply(baseOnFn, [ctx, ...a]); };
  proxy.$on('warn', () => {});
  captured = handlerId.captured;
  void originalTx;
  // Fallback: if the capture trick didn't yield, a plain await on
  // `$transaction(cb)` will pass `this` (the base) as cb's argument.
  if (!captured) {
    await proxy.$transaction(async (client) => { captured = client; });
  }
  return captured;
}
