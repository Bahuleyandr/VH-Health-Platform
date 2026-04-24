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

  beforeEach(async () => {
    jest.resetModules();
    // Ensure read-replica env var is unset for the primary-fallback test;
    // specific tests re-import after setting it to true.
    delete process.env.DATABASE_READ_URL;
    process.env.DATABASE_URL = 'postgresql://test@localhost/test';
    prismaModule = await import('../../lib/prisma.js');
    prismaModule.__resetCircuitBreakerForTests();
    jest.clearAllMocks();
  });

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
