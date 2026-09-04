// src/tests/unit/prismaCoverage.test.js
//
// Coverage-completion unit tests for src/lib/prisma.js (roadmap B3.2).
//
// prismaHardening.test.js already covers the breaker-open / 42P01-ignore /
// basic setTenant / read-replica-fallback happy paths. This SEPARATE file
// targets the still-uncovered wrapper logic (uncovered ~787-963 + the
// auto-wrap / posture / runtime-role branches):
//
//   - circuit-breaker half-open recovery + circuitBreakerStatus().resetInMs
//   - makeClient() throw on missing URL + the $on('warn'/'error'/'query')
//     listeners (incl. the >1000ms slow-query log path)
//   - applyStatementTimeoutToUrl via STATEMENT_TIMEOUT_MS (existing + fresh
//     `options` param) and the unparseable-URL catch
//   - Phase-2 auto-wrap: maybeRunUnderTenant (raw) + wrapModelDelegate
//     (model API) under AUTH_ENFORCE_TENANT_RLS=true with an active
//     AsyncLocalStorage tenant context; recursion-guard + no-context skips
//   - setTenantTx superAdmin / readOnly routing + runtime-role SET LOCAL ROLE
//   - pickTenantClient via { readOnly } with a configured replica
//   - evaluateTenantRlsPosture (pure): every reason branch
//   - tenantRlsRolePosture + logTenantRlsRolePosture: probe success (each
//     verdict), probe failure, replica probe + replica failure
//   - rlsDisabledLogLevel + tenantRlsRuntimeRole (canonical + alias + trim)
//   - ensureTenantRlsRuntimeRoleGrants: skip / unsafe-name / success / error
//   - the process 'beforeExit' shutdown handler ($disconnect both clients)
//
// We mock @prisma/client + @prisma/adapter-pg so NO real DB is opened and the
// real singleton other suites import is never perturbed (each test re-imports
// the module after jest.resetModules()). tenantContext / tenantRlsConfig /
// schemaMissingGuard / prometheusMiddleware are left REAL so the
// AsyncLocalStorage + env-flag + SQLSTATE branches exercise real code.

import { jest } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: mockLogger }));

// Capture each PrismaPg adapter's connection string so we can assert
// statement_timeout application without a real driver.
const adapterConnStrings = [];
class PrismaPgStub {
  constructor(opts) {
    this.options = opts;
    adapterConnStrings.push(opts?.connectionString);
  }
}
jest.unstable_mockModule('@prisma/adapter-pg', () => ({ PrismaPg: PrismaPgStub }));

// PrismaClient stub. Records its $on handlers so a test can FIRE the
// warn/error/query listeners (incl. the slow-query path). $transaction
// delegates the callback to a per-instance `tx` (defaults to `this`) so
// setTenant/setTenantTx run the preamble against a controllable client.
const allStubs = [];
class PrismaClientStub {
  constructor(opts) {
    this.options = opts;
    this.handlers = new Map();
    this.txClient = null; // when set, $transaction passes this to the cb
    this.$queryRaw = jest.fn(async () => []);
    this.$queryRawUnsafe = jest.fn(async () => []);
    this.$executeRaw = jest.fn(async () => 0);
    this.$executeRawUnsafe = jest.fn(async () => 0);
    this.$transaction = jest.fn(async (cb) => {
      if (typeof cb === 'function') return cb(this.txClient || this);
      return cb;
    });
    this.$connect = jest.fn(async () => {});
    this.$disconnect = jest.fn(async () => {});
    this.$on = jest.fn((level, handler) => {
      this.handlers.set(level, handler);
      return this;
    });
    allStubs.push(this);
  }

  fire(level, event) {
    const h = this.handlers.get(level);
    if (!h) throw new Error(`no ${level} handler registered`);
    return h(event);
  }
}
jest.unstable_mockModule('@prisma/client', () => ({ PrismaClient: PrismaClientStub }));

// ── Shared helpers ─────────────────────────────────────────────────────

const TENANT_RLS_ENV = [
  'AUTH_ENFORCE_TENANT_RLS',
  'AUTH_TENANT_RLS_RUNTIME_ROLE',
  'AUTH_TENANT_RLS_TEST_ROLE',
  'DATABASE_READ_URL',
  'STATEMENT_TIMEOUT_MS',
  'STATEMENT_TIMEOUT_READ_MS',
];

function clearRlsEnv() {
  for (const k of TENANT_RLS_ENV) delete process.env[k];
}

async function freshImport() {
  jest.resetModules();
  allStubs.length = 0;
  adapterConnStrings.length = 0;
  process.env.DATABASE_URL = 'postgresql://test@localhost/test';
  const mod = await import('../../lib/prisma.js');
  mod.__resetCircuitBreakerForTests();
  jest.clearAllMocks();
  return mod;
}

// The base primary stub is the first PrismaClientStub constructed in the
// module. (When a distinct DATABASE_READ_URL is set, allStubs[1] is the
// read-replica base client.)
function primaryBase() {
  return allStubs[0];
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('src/lib/prisma.js coverage completion', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    clearRlsEnv();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    clearRlsEnv();
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  // ── makeClient + Prisma event listeners ───────────────────────────────

  describe('makeClient / event listeners', () => {
    it('throws when DATABASE_URL is unset at import time', async () => {
      jest.resetModules();
      const saved = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      await expect(import('../../lib/prisma.js')).rejects.toThrow(/DATABASE_URL is required/);
      process.env.DATABASE_URL = saved;
    });

    it('wires warn/error/query listeners; slow query (>1000ms) logs a warning', async () => {
      await freshImport();
      const base = primaryBase();

      // warn + error listeners forward to logger.
      base.fire('warn', { message: 'w', target: 'tgt' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Prisma[primary] warning',
        expect.objectContaining({ message: 'w' }),
      );
      base.fire('error', { message: 'e', target: 'tgt' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Prisma[primary] error',
        expect.objectContaining({ message: 'e' }),
      );

      // query listener: slow query warns, fast query stays silent.
      mockLogger.warn.mockClear();
      base.fire('query', { duration: 1500, query: 'SELECT pg_sleep(2)' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Slow Prisma[primary] query',
        expect.objectContaining({ duration_ms: 1500 }),
      );
      mockLogger.warn.mockClear();
      base.fire('query', { duration: 5, query: 'SELECT 1' });
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('truncates a very long slow-query string to 200 chars in the log', async () => {
      await freshImport();
      const base = primaryBase();
      const longQuery = `SELECT ${'a'.repeat(500)}`;
      base.fire('query', { duration: 2000, query: longQuery });
      const call = mockLogger.warn.mock.calls.find((c) => c[0] === 'Slow Prisma[primary] query');
      expect(call[1].query.length).toBe(200);
    });
  });

  // ── applyStatementTimeoutToUrl (via env) ──────────────────────────────

  describe('applyStatementTimeoutToUrl (statement_timeout)', () => {
    it('appends -c statement_timeout when STATEMENT_TIMEOUT_MS > 0', async () => {
      process.env.STATEMENT_TIMEOUT_MS = '30000';
      await freshImport();
      // URLSearchParams encodes the space in "-c statement_timeout=…" as '+'.
      const conn = adapterConnStrings[0];
      expect(conn).toContain('options=-c+statement_timeout%3D30000');
    });

    it('merges into an existing options param with a space', async () => {
      process.env.STATEMENT_TIMEOUT_MS = '15000';
      jest.resetModules();
      allStubs.length = 0;
      adapterConnStrings.length = 0;
      process.env.DATABASE_URL = 'postgresql://test@localhost/test?options=-c%20search_path%3Dpublic';
      const mod = await import('../../lib/prisma.js');
      mod.__resetCircuitBreakerForTests();
      const conn = decodeURIComponent(adapterConnStrings[0]);
      expect(conn).toContain('search_path=public');
      expect(conn).toContain('statement_timeout=15000');
      delete process.env.DATABASE_URL;
    });

    it('adds no statement_timeout when the timeout is 0', async () => {
      process.env.STATEMENT_TIMEOUT_MS = '0';
      await freshImport();
      const conn = decodeURIComponent(adapterConnStrings[0]);
      expect(conn).not.toContain('statement_timeout');
      // The URL is no longer byte-identical to the input: every connection now
      // carries the UTC session pin (pinSessionTimeZoneToUrl), which is what
      // keeps a timestamptz decoding to the same instant on any server.
      // As above, URLSearchParams encodes the space in "-c timezone=…" as '+',
      // and decodeURIComponent does not turn '+' back into a space.
      expect(conn).toContain('timezone=UTC');
    });

    it('returns an unparseable URL as-is (catch branch)', async () => {
      process.env.STATEMENT_TIMEOUT_MS = '30000';
      jest.resetModules();
      allStubs.length = 0;
      adapterConnStrings.length = 0;
      process.env.DATABASE_URL = 'not a valid url at all';
      const mod = await import('../../lib/prisma.js');
      mod.__resetCircuitBreakerForTests();
      expect(adapterConnStrings[0]).toBe('not a valid url at all');
      delete process.env.DATABASE_URL;
    });
  });

  // ── circuit breaker: half-open recovery + status.resetInMs ─────────────

  describe('circuit breaker half-open recovery', () => {
    it('half-opens after RESET_MS: a success closes the breaker', async () => {
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();

      // Trip the breaker with 5 infra failures.
      base.$queryRawUnsafe = jest.fn(() => Promise.reject(new Error('infra down')));
      for (let i = 0; i < 5; i += 1) {
        await expect(prisma.$queryRawUnsafe('q')).rejects.toThrow('infra down');
      }
      expect(mod.circuitBreakerStatus().open).toBe(true);

      // resetInMs is a positive number while open.
      const openStatus = mod.circuitBreakerStatus();
      expect(openStatus.resetInMs).toBeGreaterThan(0);
      expect(openStatus.resetInMs).toBeLessThanOrEqual(30_000);

      // Advance virtual time past the 30s reset window.
      const realNow = Date.now;
      Date.now = () => realNow() + 31_000;
      try {
        base.$queryRawUnsafe = jest.fn(async () => [{ ok: 1 }]);
        const rows = await prisma.$queryRawUnsafe('SELECT 1');
        expect(rows).toEqual([{ ok: 1 }]);
      } finally {
        Date.now = realNow;
      }
      const status = mod.circuitBreakerStatus();
      expect(status.open).toBe(false);
      expect(status.consecutiveFailures).toBe(0);
      expect(status.resetInMs).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('half-open'),
      );
    });

    it('half-open then a failure re-opens the breaker', async () => {
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();

      base.$queryRawUnsafe = jest.fn(() => Promise.reject(new Error('down')));
      for (let i = 0; i < 5; i += 1) {
        await expect(prisma.$queryRawUnsafe('q')).rejects.toThrow('down');
      }
      expect(mod.circuitBreakerStatus().open).toBe(true);

      const realNow = Date.now;
      Date.now = () => realNow() + 31_000;
      try {
        // Half-open lets one through; it fails → breaker re-opens.
        await expect(prisma.$queryRawUnsafe('q')).rejects.toThrow('down');
      } finally {
        Date.now = realNow;
      }
      expect(mod.circuitBreakerStatus().open).toBe(true);
    });

    it('rejects immediately while open and within the reset window', async () => {
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();

      base.$queryRawUnsafe = jest.fn(() => Promise.reject(new Error('down')));
      for (let i = 0; i < 5; i += 1) {
        await expect(prisma.$queryRawUnsafe('q')).rejects.toThrow('down');
      }
      expect(mod.circuitBreakerStatus().open).toBe(true);

      // Still inside the 30s window → fail-fast WITHOUT invoking the client.
      base.$queryRawUnsafe.mockClear();
      await expect(prisma.$queryRawUnsafe('q')).rejects.toThrow(
        /Database circuit breaker is open/,
      );
      expect(base.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('a non-object rejection (string) is treated as an infra failure', async () => {
      // Exercises the isIgnoredBreakerError null/non-object guard: a thrown
      // string is not an object → not ignored → counts toward the budget.
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(() => Promise.reject('plain string error'));

      await expect(prisma.$queryRawUnsafe('q')).rejects.toBe('plain string error');
      expect(mod.circuitBreakerStatus().consecutiveFailures).toBe(1);
    });

    // M12 (audit 2026-06-22): the breaker state must be PER-CLIENT. Before the
    // fix, consecutiveFailures/circuitOpen were module-global and shared by the
    // primary AND read-replica clients, so a replica outage browned out primary
    // queries (and vice versa). Infra failures are global per CLIENT, not
    // global across clients — the meaningful fault boundary is primary vs
    // replica.
    it('opens ONLY the failing client breaker — a replica outage leaves primary available', async () => {
      process.env.DATABASE_READ_URL = 'postgresql://test@replica/test';
      const mod = await freshImport();
      const primary = mod.default;
      const replica = mod.prismaReadOnly;
      expect(replica).not.toBe(primary);

      const primaryStub = allStubs[0];
      const replicaStub = allStubs[1];
      primaryStub.$queryRawUnsafe = jest.fn(async () => [{ ok: 1 }]); // healthy
      replicaStub.$queryRawUnsafe = jest.fn(() => Promise.reject(new Error('replica down')));

      // Trip the replica breaker with 5 consecutive infra failures.
      for (let i = 0; i < 5; i += 1) {
        await expect(replica.$queryRawUnsafe('q')).rejects.toThrow('replica down');
      }
      // Replica now fails fast (breaker open) WITHOUT touching the client.
      replicaStub.$queryRawUnsafe.mockClear();
      await expect(replica.$queryRawUnsafe('q')).rejects.toThrow(/circuit breaker is open/i);
      expect(replicaStub.$queryRawUnsafe).not.toHaveBeenCalled();

      // PRIMARY breaker is untouched — primary queries still execute.
      await expect(primary.$queryRawUnsafe('SELECT 1')).resolves.toEqual([{ ok: 1 }]);

      // Status reports per-tag: aggregate open true; only readOnly is open.
      const status = mod.circuitBreakerStatus();
      expect(status.open).toBe(true); // back-compat aggregate = ANY open
      expect(status.byTag.readOnly.open).toBe(true);
      expect(status.byTag.primary.open).toBe(false);

      delete process.env.DATABASE_READ_URL;
    });
  });

  // ── Phase-2 auto-wrap: raw-SQL methods (maybeRunUnderTenant) ───────────

  describe('auto-wrap raw SQL under active tenant context', () => {
    it('routes a raw call through setTenant (set_config preamble) when flag + ctx active', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();
      const tenantCtx = await import('../../lib/tenantContext.js');

      // tx the $transaction hands to the callback; its $queryRawUnsafe records
      // the set_config preamble + the auto-wrapped user query.
      const tx = new PrismaClientStub();
      base.txClient = tx;

      const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const rows = await tenantCtx.runInTenantContext(tenantId, () =>
        prisma.$queryRawUnsafe('SELECT * FROM appointments'));

      expect(rows).toEqual([]);
      // First stmt is the GUC preamble with the tenantId.
      expect(tx.$queryRawUnsafe).toHaveBeenNthCalledWith(
        1,
        "SELECT set_config('app.current_tenant_id', $1, true)",
        tenantId,
      );
      // Then the actual user query (auto-wrapped through tx).
      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith('SELECT * FROM appointments');
      // The base (non-tx) client's own raw method was NOT used directly.
      expect(base.$queryRawUnsafe).not.toHaveBeenCalledWith('SELECT * FROM appointments');
    });

    it('superAdmin context routes through setTenant with bypass GUC', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();
      const tenantCtx = await import('../../lib/tenantContext.js');
      const tx = new PrismaClientStub();
      base.txClient = tx;

      await tenantCtx.runWithSuperAdmin(() => prisma.$queryRaw`SELECT 1`);

      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        'bypass',
      );
    });

    it('does NOT auto-wrap when already inside a setTenant tx (recursion guard)', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      const tx = new PrismaClientStub();
      base.txClient = tx;

      const tenantId = '11111111-1111-1111-1111-111111111111';
      // setTenant marks inSetTenant; the callback's tx call must NOT re-wrap.
      await mod.setTenant(tenantId, async (client) => {
        await client.$queryRawUnsafe('SELECT inner');
      });

      // Exactly two calls on tx: the preamble + the single inner query.
      // (A recursion bug would issue a second set_config preamble.)
      const preambleCalls = tx.$queryRawUnsafe.mock.calls.filter(
        (c) => c[0] === "SELECT set_config('app.current_tenant_id', $1, true)",
      );
      expect(preambleCalls).toHaveLength(1);
    });

    it('does NOT auto-wrap when flag is on but there is no tenant context', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{ direct: true }]);

      // No runInTenantContext wrapper → ctx is null → passthrough.
      const rows = await prisma.$queryRawUnsafe('SELECT direct');
      expect(rows).toEqual([{ direct: true }]);
      expect(base.$queryRawUnsafe).toHaveBeenCalledWith('SELECT direct');
    });

    it('does NOT auto-wrap when context has neither tenantId nor superAdmin', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();
      const tenantCtx = await import('../../lib/tenantContext.js');
      base.$queryRawUnsafe = jest.fn(async () => [{ pass: true }]);

      const rows = await tenantCtx.runInTenantContext(null, () =>
        prisma.$queryRawUnsafe('SELECT pass'));
      expect(rows).toEqual([{ pass: true }]);
      expect(base.$queryRawUnsafe).toHaveBeenCalledWith('SELECT pass');
    });

    it('passes through unchanged when the RLS flag is OFF even with a context', async () => {
      // flag unset → isTenantRlsEnforcementEnabled() false in test env.
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();
      const tenantCtx = await import('../../lib/tenantContext.js');
      base.$queryRawUnsafe = jest.fn(async () => [{ legacy: true }]);

      const rows = await tenantCtx.runInTenantContext('some-tenant', () =>
        prisma.$queryRawUnsafe('SELECT legacy'));
      expect(rows).toEqual([{ legacy: true }]);
      expect(base.$queryRawUnsafe).toHaveBeenCalledWith('SELECT legacy');
    });
  });

  // ── Phase-2 auto-wrap: model delegates (wrapModelDelegate) ─────────────

  describe('model-delegate tenant wrapping', () => {
    // A base client whose `appointments` delegate has findMany/update etc.
    function withModelDelegate() {
      const base = primaryBase();
      base.appointments = {
        findMany: jest.fn(async () => [{ id: 1 }]),
        update: jest.fn(async () => ({ id: 1 })),
        $extends: 'not-a-real-fn',
      };
      return base;
    }

    it('wraps a model call through setTenant when flag + ctx active', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const prisma = mod.default;
      const base = withModelDelegate();
      const tenantCtx = await import('../../lib/tenantContext.js');

      // tx exposes the same model delegate; record its findMany.
      const tx = new PrismaClientStub();
      tx.appointments = { findMany: jest.fn(async () => [{ id: 99 }]) };
      base.txClient = tx;

      const tenantId = '22222222-3333-4444-5555-666666666666';
      const out = await tenantCtx.runInTenantContext(tenantId, () =>
        prisma.appointments.findMany({ where: { x: 1 } }));

      expect(out).toEqual([{ id: 99 }]);
      // The tx model delegate was used inside the scoped transaction.
      expect(tx.appointments.findMany).toHaveBeenCalledWith({ where: { x: 1 } });
      // And the GUC preamble ran first.
      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        tenantId,
      );
    });

    it('model delegate passes through directly when no tenant context', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const prisma = mod.default;
      const base = withModelDelegate();

      const out = await prisma.appointments.findMany({ where: { y: 2 } });
      expect(out).toEqual([{ id: 1 }]);
      expect(base.appointments.findMany).toHaveBeenCalledWith({ where: { y: 2 } });
    });

    it('returns the SAME proxy for a model delegate on repeated access (cache)', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const prisma = mod.default;
      withModelDelegate();

      const first = prisma.appointments;
      const second = prisma.appointments;
      expect(first).toBe(second);
    });

    it('non-function / $-prefixed members of a delegate are returned untouched', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const prisma = mod.default;
      const base = primaryBase();
      base.widgets = {
        findMany: jest.fn(async () => []),
        label: 'plain-string', // non-function property
      };
      // Accessing a non-function delegate prop returns it as-is.
      expect(prisma.widgets.label).toBe('plain-string');
    });
  });

  // ── setTenantTx routing: superAdmin / readOnly / runtime role ──────────

  describe('setTenantTx routing + runtime role', () => {
    it('throws when neither tenantId nor superAdmin is given', async () => {
      const mod = await freshImport();
      await expect(mod.setTenantTx(null, async () => 'x')).rejects.toThrow(
        /requires tenantId/,
      );
    });

    it('setTenant (not setTenantTx) throws its own no-tenant guard', async () => {
      // setTenant has a separate guard before delegating to setTenantTx.
      const mod = await freshImport();
      await expect(mod.setTenant(null, async () => 'x')).rejects.toThrow(
        /setTenant requires tenantId/,
      );
    });

    it('issues SET LOCAL ROLE before the GUC when a runtime role is configured', async () => {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
      const mod = await freshImport();
      const base = primaryBase();
      const tx = new PrismaClientStub();
      base.txClient = tx;

      await mod.setTenantTx('33333333-4444-5555-6666-777777777777', async () => 'ok');

      // SET LOCAL ROLE is the first statement (executeRawUnsafe), GUC second.
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE vhhealth_app');
      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        '33333333-4444-5555-6666-777777777777',
      );
    });

    it('routes a readOnly tx to the replica client when DATABASE_READ_URL is set', async () => {
      process.env.DATABASE_READ_URL = 'postgresql://test@replica/test';
      const mod = await freshImport();
      // allStubs[0] = primary base, allStubs[1] = replica base.
      const replicaBase = allStubs[1];
      const primary = allStubs[0];
      const txPrimary = new PrismaClientStub();
      const txReplica = new PrismaClientStub();
      primary.txClient = txPrimary;
      replicaBase.txClient = txReplica;

      await mod.setTenantTx('44444444-5555-6666-7777-888888888888', async () => 'ro', {
        readOnly: true,
      });

      // The replica's $transaction ran, primary's did not.
      expect(replicaBase.$transaction).toHaveBeenCalled();
      expect(primary.$transaction).not.toHaveBeenCalled();
      expect(txReplica.$queryRawUnsafe).toHaveBeenCalledWith(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        '44444444-5555-6666-7777-888888888888',
      );
    });

    it('readOnly is a no-op (uses primary) when no replica is configured', async () => {
      const mod = await freshImport();
      const primary = allStubs[0];
      const tx = new PrismaClientStub();
      primary.txClient = tx;

      await mod.setTenant('55555555-6666-7777-8888-999999999999', async () => 'x', {
        readOnly: true,
      });
      expect(primary.$transaction).toHaveBeenCalled();
    });

    it('forwards explicit interactive transaction acquisition and runtime bounds', async () => {
      const mod = await freshImport();
      const primary = allStubs[0];

      await mod.setTenantTx('66666666-7777-4888-8999-aaaaaaaaaaaa', async () => 'bounded', {
        isolationLevel: 'Serializable',
        maxWait: 4_000,
        timeout: 30_000,
      });

      expect(primary.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        {
          isolationLevel: 'Serializable',
          maxWait: 4_000,
          timeout: 30_000,
        },
      );
    });
  });

  // ── circuitBreakerStatus shape ────────────────────────────────────────

  describe('circuitBreakerStatus', () => {
    it('reports openedAt=null and resetInMs=0 when closed', async () => {
      const mod = await freshImport();
      const status = mod.circuitBreakerStatus();
      expect(status).toEqual({
        open: false,
        consecutiveFailures: 0,
        openedAt: null,
        resetInMs: 0,
        // M12: per-client breakdown — empty until a client is exercised.
        byTag: {},
      });
    });
  });

  // ── tenantRlsRuntimeRole ──────────────────────────────────────────────

  describe('tenantRlsRuntimeRole', () => {
    it('prefers the canonical AUTH_TENANT_RLS_RUNTIME_ROLE', async () => {
      const mod = await freshImport();
      expect(
        mod.tenantRlsRuntimeRole({
          AUTH_TENANT_RLS_RUNTIME_ROLE: 'canon_role',
          AUTH_TENANT_RLS_TEST_ROLE: 'legacy_role',
        }),
      ).toBe('canon_role');
    });

    it('falls back to the legacy AUTH_TENANT_RLS_TEST_ROLE alias', async () => {
      const mod = await freshImport();
      expect(mod.tenantRlsRuntimeRole({ AUTH_TENANT_RLS_TEST_ROLE: 'legacy_role' })).toBe(
        'legacy_role',
      );
    });

    it('trims whitespace and returns null for blank / unset', async () => {
      const mod = await freshImport();
      expect(mod.tenantRlsRuntimeRole({ AUTH_TENANT_RLS_RUNTIME_ROLE: '  spaced  ' })).toBe(
        'spaced',
      );
      expect(mod.tenantRlsRuntimeRole({ AUTH_TENANT_RLS_RUNTIME_ROLE: '   ' })).toBeNull();
      expect(mod.tenantRlsRuntimeRole({})).toBeNull();
    });
  });

  // ── rlsDisabledLogLevel ───────────────────────────────────────────────

  describe('rlsDisabledLogLevel', () => {
    it('is warn in production, info elsewhere', async () => {
      const mod = await freshImport();
      expect(mod.rlsDisabledLogLevel('production')).toBe('warn');
      expect(mod.rlsDisabledLogLevel('PRODUCTION')).toBe('warn');
      expect(mod.rlsDisabledLogLevel('development')).toBe('info');
      expect(mod.rlsDisabledLogLevel(undefined)).toBe('info');
    });
  });

  // ── evaluateTenantRlsPosture (pure, all branches) ─────────────────────

  describe('evaluateTenantRlsPosture', () => {
    let evaluate;
    beforeEach(async () => {
      const mod = await freshImport();
      evaluate = mod.evaluateTenantRlsPosture;
    });

    it('enforcement disabled → ok:true, reason enforcement_disabled', () => {
      const v = evaluate({ enforced: false, connectionRole: 'vhhealth', connectionBypassesRls: true });
      expect(v).toMatchObject({ enforced: false, ok: true, reason: 'enforcement_disabled', effectiveRole: 'vhhealth' });
    });

    it('connection role bypasses RLS → ok:false, effective_role_bypasses_rls', () => {
      const v = evaluate({ enforced: true, connectionRole: 'postgres', connectionBypassesRls: true });
      expect(v).toMatchObject({ ok: false, reason: 'effective_role_bypasses_rls', effectiveRole: 'postgres' });
    });

    it('test role precedence: testRole used as effective role + its bypass flag', () => {
      const v = evaluate({
        enforced: true,
        connectionRole: 'postgres',
        connectionBypassesRls: true, // would bypass, but testRole overrides
        testRole: 'vhhealth_app',
        testRoleBypassesRls: false,
      });
      expect(v).toMatchObject({ ok: true, reason: 'enforced', effectiveRole: 'vhhealth_app', bypassesRls: false });
    });

    it('owner-exempt unforced tables → ok:false, owner_exempt_unforced_tables', () => {
      const v = evaluate({
        enforced: true,
        connectionRole: 'vhhealth',
        connectionBypassesRls: false,
        effectiveRoleOwnsUnforcedRlsTables: 3,
      });
      expect(v).toMatchObject({ ok: false, reason: 'owner_exempt_unforced_tables', unforcedOwnedRlsTables: 3 });
    });

    it('replica role bypasses RLS → ok:false, replica_role_bypasses_rls', () => {
      const v = evaluate({
        enforced: true,
        connectionRole: 'vhhealth',
        connectionBypassesRls: false,
        replicaProbed: true,
        replicaConnectionRole: 'replica_super',
        replicaConnectionBypassesRls: true,
      });
      expect(v).toMatchObject({
        ok: false,
        reason: 'replica_role_bypasses_rls',
        replicaBypassesRls: true,
        replicaEffectiveRole: 'replica_super',
      });
    });

    it('all sound → ok:true, reason enforced (with replica probed + clean)', () => {
      const v = evaluate({
        enforced: true,
        connectionRole: 'vhhealth_app',
        connectionBypassesRls: false,
        replicaProbed: true,
        replicaConnectionRole: 'vhhealth_app',
        replicaConnectionBypassesRls: false,
      });
      expect(v).toMatchObject({ ok: true, reason: 'enforced', replicaBypassesRls: false });
    });

    it('defaults (no args) → enforced undefined falsy → enforcement_disabled', () => {
      const v = evaluate();
      expect(v.reason).toBe('enforcement_disabled');
    });
  });

  // ── tenantRlsRolePosture (probe) ──────────────────────────────────────

  describe('tenantRlsRolePosture', () => {
    it('returns a sound verdict from a clean primary probe', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'vhhealth_app',
        connection_bypasses_rls: false,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);

      const posture = await mod.tenantRlsRolePosture();
      expect(posture).toMatchObject({
        enforced: true,
        ok: true,
        reason: 'enforced',
        connectionRole: 'vhhealth_app',
        replicaProbed: false,
      });
    });

    it('flags a bypassing connection role', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'postgres',
        connection_bypasses_rls: true,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);

      const posture = await mod.tenantRlsRolePosture();
      expect(posture).toMatchObject({ ok: false, reason: 'effective_role_bypasses_rls' });
    });

    it('returns the probe-error shape when the query throws', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(() => Promise.reject(new Error('connection refused')));

      const posture = await mod.tenantRlsRolePosture();
      expect(posture).toMatchObject({
        ok: null,
        error: 'rls_posture_probe_failed',
        reason: 'probe_error',
        message: 'connection refused',
      });
    });

    it('probes the replica too and folds a bypassing replica into the verdict', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      process.env.DATABASE_READ_URL = 'postgresql://test@replica/test';
      const mod = await freshImport();
      const primary = allStubs[0];
      const replica = allStubs[1];
      primary.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'vhhealth_app',
        connection_bypasses_rls: false,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);
      replica.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'replica_super',
        connection_bypasses_rls: true,
        test_role_bypasses_rls: false,
      }]);

      const posture = await mod.tenantRlsRolePosture();
      expect(posture).toMatchObject({
        ok: false,
        reason: 'replica_role_bypasses_rls',
        replicaProbed: true,
        replicaConnectionRole: 'replica_super',
      });
    });

    it('a failing replica probe does not corrupt a sound primary verdict', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      process.env.DATABASE_READ_URL = 'postgresql://test@replica/test';
      const mod = await freshImport();
      const primary = allStubs[0];
      const replica = allStubs[1];
      primary.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'vhhealth_app',
        connection_bypasses_rls: false,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);
      replica.$queryRawUnsafe = jest.fn(() => Promise.reject(new Error('replica down')));

      const posture = await mod.tenantRlsRolePosture();
      expect(posture).toMatchObject({ ok: true, reason: 'enforced', replicaProbed: false });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('replica posture probe failed'),
        expect.objectContaining({ message: 'replica down' }),
      );
    });

    it('handles an empty result row (defaults applied)', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => []); // rows?.[0] => {}

      const posture = await mod.tenantRlsRolePosture();
      // empty row → connection_bypasses_rls falsy, no unforced tables → enforced
      expect(posture).toMatchObject({ enforced: true, ok: true, reason: 'enforced' });
    });
  });

  // ── logTenantRlsRolePosture (each branch) ─────────────────────────────

  describe('logTenantRlsRolePosture', () => {
    it('warns when the probe failed', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(() => Promise.reject(new Error('boom')));

      const posture = await mod.logTenantRlsRolePosture();
      expect(posture.error).toBe('rls_posture_probe_failed');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Tenant RLS posture probe failed',
        expect.objectContaining({ reason: 'probe_error' }),
      );
    });

    it('warns loudly when enforcement is OFF in production', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
      process.env.NODE_ENV = 'production';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'vhhealth',
        connection_bypasses_rls: false,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);

      await mod.logTenantRlsRolePosture();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('TENANT RLS ENFORCEMENT IS OFF in production'),
        expect.any(Object),
      );
    });

    it('info-logs when enforcement is off outside production', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'false';
      process.env.NODE_ENV = 'test';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'vhhealth',
        connection_bypasses_rls: false,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);

      await mod.logTenantRlsRolePosture();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Tenant RLS enforcement disabled (AUTH_ENFORCE_TENANT_RLS != true)',
        expect.any(Object),
      );
    });

    it('errors on owner_exempt_unforced_tables verdict', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'vhhealth',
        connection_bypasses_rls: false,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 5,
      }]);

      const posture = await mod.logTenantRlsRolePosture();
      expect(posture.reason).toBe('owner_exempt_unforced_tables');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('TENANT RLS IS PARTIALLY INERT'),
        expect.objectContaining({ unforcedOwnedRlsTables: 5 }),
      );
    });

    it('errors on replica_role_bypasses_rls verdict', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      process.env.DATABASE_READ_URL = 'postgresql://test@replica/test';
      const mod = await freshImport();
      const primary = allStubs[0];
      const replica = allStubs[1];
      primary.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'vhhealth_app',
        connection_bypasses_rls: false,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);
      replica.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'replica_super',
        connection_bypasses_rls: true,
        test_role_bypasses_rls: false,
      }]);

      const posture = await mod.logTenantRlsRolePosture();
      expect(posture.reason).toBe('replica_role_bypasses_rls');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('PARTIALLY INERT ON THE READ REPLICA'),
        expect.any(Object),
      );
    });

    it('errors on the generic bypassing-role verdict', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'postgres',
        connection_bypasses_rls: true,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);

      const posture = await mod.logTenantRlsRolePosture();
      expect(posture.reason).toBe('effective_role_bypasses_rls');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('TENANT RLS IS NOT ENFORCED'),
        expect.any(Object),
      );
    });

    it('info-logs the OK verdict (via SET LOCAL ROLE when a runtime role is set)', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'postgres',
        connection_bypasses_rls: true, // bypasses, but testRole overrides → sound
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);

      const posture = await mod.logTenantRlsRolePosture();
      expect(posture.ok).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Tenant RLS posture OK — isolation will enforce',
        expect.objectContaining({ via: 'SET LOCAL ROLE' }),
      );
    });

    it('info-logs the OK verdict via connection role when no runtime role', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      const mod = await freshImport();
      const base = primaryBase();
      base.$queryRawUnsafe = jest.fn(async () => [{
        connection_role: 'vhhealth_app',
        connection_bypasses_rls: false,
        test_role_bypasses_rls: false,
        unforced_owned_rls_tables: 0,
      }]);

      const posture = await mod.logTenantRlsRolePosture();
      expect(posture.ok).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Tenant RLS posture OK — isolation will enforce',
        expect.objectContaining({ via: 'connection role' }),
      );
    });
  });

  // ── ensureTenantRlsRuntimeRoleGrants ──────────────────────────────────

  describe('ensureTenantRlsRuntimeRoleGrants', () => {
    it('skips when no runtime role is configured', async () => {
      const mod = await freshImport();
      const result = await mod.ensureTenantRlsRuntimeRoleGrants();
      expect(result).toEqual({ skipped: true, reason: 'no_runtime_role_configured' });
    });

    it('skips + errors on an unsafe role name', async () => {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'bad; DROP TABLE users;--';
      const mod = await freshImport();
      const result = await mod.ensureTenantRlsRuntimeRoleGrants();
      expect(result).toEqual({ skipped: true, reason: 'unsafe_role_name' });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('not a safe identifier'),
        expect.objectContaining({ role: 'bad; DROP TABLE users;--' }),
      );
    });

    it('runs the grant DDL and reports success for a safe role', async () => {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
      const mod = await freshImport();
      const base = primaryBase();
      base.$executeRawUnsafe = jest.fn(async () => 0);

      const result = await mod.ensureTenantRlsRuntimeRoleGrants();
      expect(result).toEqual({ skipped: false, role: 'vhhealth_app' });
      expect(base.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('CREATE ROLE vhhealth_app'),
      );
      const grantSql = base.$executeRawUnsafe.mock.calls[0][0];
      expect(grantSql).toContain(
        "pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)",
      );
      expect(grantSql).toContain(
        'REVOKE CREATE ON SCHEMA public FROM PUBLIC',
      );
      expect(grantSql).toContain(
        'REVOKE CREATE ON SCHEMA public FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        "pg_catalog.to_regprocedure('public.pathway_projector_enqueue_new_event()')",
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON FUNCTION public.pathway_projector_enqueue_new_event()\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        "pg_catalog.to_regclass('public.clinical_continuity_policy_versions')",
      );
      expect(grantSql).toContain(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE\n          ON TABLE public.clinical_continuity_policy_versions\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE\n          ON TABLE public.clinical_continuity_edge_access_grants\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        'tenant_id, facility_id, location_type, location_identifier,\n          staff_uid, device_id, client_certificate_sha256,',
      );
      for (const sequence of [
        'clinical_continuity_capture_revision_seq',
        'clinical_continuity_context_revision_seq',
      ]) {
        const revoke = `REVOKE ALL PRIVILEGES\n          ON SEQUENCE public.${sequence}`;
        expect(grantSql).toContain(revoke);
        expect(grantSql.indexOf(revoke)).toBeGreaterThan(grantSql.indexOf(
          'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public',
        ));
      }
      expect(grantSql).not.toContain(
        'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public',
      );
      expect(grantSql).not.toContain(
        'GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vhhealth_app',
      );
      for (const relation of [
        'care_pathway_reconciliation_checks',
        'clinical_continuity_replay_receipts',
        'clinical_continuity_replay_attempts',
      ]) {
        expect(grantSql).toContain(`'${relation}'`);
      }
      for (const guardedFunction of [
        'assert_cc_reconciliation_append_only()',
        'validate_imaging_study_link_recovery_receipt()',
        'validate_scim_provisioning_command()',
        'cc_packet_assert_context(uuid,integer)',
      ]) {
        expect(grantSql).toContain(`'${guardedFunction}'`);
      }
      expect(grantSql).toContain(
        "pg_catalog.to_regclass('public.event_consumer_offsets')",
      );
      expect(grantSql).toContain(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE\n          ON TABLE public.event_consumer_offsets FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        'GRANT UPDATE (\n          high_water_position, high_water_token, resume_cutoff_position,',
      );
      expect(grantSql).toContain(
        "pg_catalog.to_regclass('public.pathway_projector_inbox')",
      );
      const pathwayInboxInsertGrant = grantSql.match(
        /GRANT INSERT \(\s*([a-z0-9_,\s]+?)\s*\) ON TABLE public\.pathway_projector_inbox TO vhhealth_app/,
      );
      expect(pathwayInboxInsertGrant).not.toBeNull();
      expect(pathwayInboxInsertGrant[1].split(',').map(column => column.trim())).toEqual([
        'scope_kind',
        'tenant_id',
        'consumer_key',
        'generation',
        'event_id',
        'offset_id',
        'facility_id',
        'interface_family',
        'direction',
        'source_partition',
        'source_position',
        'source_token',
        'predecessor_token',
        'duplicate_key',
        'command_fingerprint',
        'occurred_at',
        'received_at',
        'recorded_at',
        'arrival_class',
        'effect_disposition',
        'status',
        'next_attempt_at',
        'policy_version',
        'policy_signature',
        'retention_policy',
        'retention_until',
        'lease_owner',
        'lease_expires_at',
      ]);
      expect(grantSql).toContain(
        "pg_catalog.to_regclass('public.hl7_inbound_recovery_receipts')",
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON TABLE public.hl7_inbound_recovery_receipts\n          FROM vhhealth_app',
      );
      expect(grantSql.indexOf(
        'REVOKE ALL PRIVILEGES\n          ON TABLE public.hl7_inbound_recovery_receipts',
      )).toBeGreaterThan(grantSql.indexOf(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public',
      ));
      expect(grantSql).toContain(
        'GRANT SELECT\n          ON TABLE public.hl7_inbound_recovery_receipts\n          TO vhhealth_app',
      );
      expect(grantSql).toContain(
        'GRANT INSERT (\n          id, tenant_id, recovery_inbox_id, interface_family,',
      );
      expect(grantSql).toContain(
        'retention_policy, retention_until\n        ) ON TABLE public.hl7_inbound_recovery_receipts TO vhhealth_app',
      );
      const i03InsertGrant = grantSql.match(
        /GRANT INSERT \(\s*([a-z0-9_,\s]+?)\s*\) ON TABLE public\.hl7_inbound_recovery_receipts TO vhhealth_app/,
      );
      expect(i03InsertGrant).not.toBeNull();
      expect(i03InsertGrant[1].split(',').map(column => column.trim())).toEqual([
        'id',
        'tenant_id',
        'recovery_inbox_id',
        'interface_family',
        'signing_credential_id',
        'source_partition',
        'generation',
        'source_position',
        'source_token',
        'predecessor_token',
        'duplicate_key',
        'message_family',
        'message_type',
        'trigger_event',
        'message_control_id_sha256',
        'payload_ciphertext',
        'payload_sha256',
        'payload_bytes',
        'source_observed_at',
        'source_received_at',
        'clock_evidence',
        'patient_uid',
        'visit_identity_sha256',
        'order_identity_sha256',
        'pending_task_id',
        'review_role',
        'status',
        'outcome_code',
        'ack_ciphertext',
        'ack_sha256',
        'ack_bytes',
        'ack_code',
        'http_status',
        'policy_version',
        'policy_signature',
        'retention_policy',
        'retention_until',
      ]);
      for (const table of [
        'fhir_vital_observation_receipts',
        'fhir_vital_observation_sets',
        'fhir_vital_observation_set_resources',
      ]) {
        expect(grantSql).toContain(
          `REVOKE ALL PRIVILEGES\n          ON TABLE public.${table}\n          FROM vhhealth_app`,
        );
        expect(grantSql.indexOf(
          `REVOKE ALL PRIVILEGES\n          ON TABLE public.${table}`,
        )).toBeGreaterThan(grantSql.indexOf(
          'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public',
        ));
      }
      expect(grantSql).toContain(
        'GRANT SELECT, INSERT\n          ON TABLE public.fhir_vital_observation_receipts\n          TO vhhealth_app',
      );
      expect(grantSql).toContain(
        'GRANT UPDATE (patient_uid)\n          ON TABLE public.fhir_vital_observation_receipts\n          TO vhhealth_app',
      );
      expect(grantSql).toContain(
        'GRANT UPDATE (\n          patient_uid,\n          vitals_chart_id,\n          news2_effects_completed_at,',
      );
      expect(grantSql).toContain(
        'anomaly_effects_next_retry_at\n        ) ON TABLE public.fhir_vital_observation_sets TO vhhealth_app',
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON FUNCTION public.validate_fhir_vital_observation_receipt_update()\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON FUNCTION public.validate_fhir_vital_observation_receipt_scope_deferred()\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON FUNCTION public.validate_fhir_vital_observation_set_scope_deferred()\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        "pg_catalog.to_regclass('public.hl7_inbound_recovery_receipts_id_seq')",
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON SEQUENCE public.hl7_inbound_recovery_receipts_id_seq\n          FROM vhhealth_app',
      );
      expect(grantSql.indexOf(
        'REVOKE ALL PRIVILEGES\n          ON SEQUENCE public.hl7_inbound_recovery_receipts_id_seq',
      )).toBeGreaterThan(grantSql.indexOf(
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public',
      ));
      expect(grantSql).toContain(
        'GRANT USAGE, SELECT\n          ON SEQUENCE public.hl7_inbound_recovery_receipts_id_seq\n          TO vhhealth_app',
      );
      const i03FunctionGrant = grantSql.indexOf(
        'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO vhhealth_app',
      );
      const i03DefaultFunctionGrant = grantSql.indexOf(
        'GRANT EXECUTE ON FUNCTIONS TO vhhealth_app',
      );
      for (const signature of [
        'public.hl7_i03_length_prefixed_sha256(text[])',
        'public.assert_hl7_inbound_recovery_task(uuid,integer,bigint,uuid,uuid,text)',
        'public.validate_hl7_inbound_recovery_receipt()',
        'public.validate_hl7_inbound_recovery_convergence()',
        'public.hl7_inbound_recovery_receipt_append_only()',
      ]) {
        expect(grantSql).toContain(`'${signature}'`);
      }
      for (const revoke of [
        'ON FUNCTION public.hl7_i03_length_prefixed_sha256(text[])',
        'ON FUNCTION public.assert_hl7_inbound_recovery_task(',
        'ON FUNCTION public.validate_hl7_inbound_recovery_receipt()',
        'ON FUNCTION public.validate_hl7_inbound_recovery_convergence()',
        'ON FUNCTION public.hl7_inbound_recovery_receipt_append_only()',
      ]) {
        expect(grantSql.indexOf(revoke)).toBeGreaterThan(i03FunctionGrant);
        expect(grantSql.indexOf(revoke)).toBeGreaterThan(i03DefaultFunctionGrant);
      }
      expect(grantSql).toContain(
        'REVOKE UPDATE, TRUNCATE\n          ON TABLE public.downtime_snapshots\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        "'public.clinical_continuity_purge_snapshot_payload(uuid,integer,integer,text)'",
      );
      expect(grantSql).toContain(
        "'public.clinical_continuity_assert_snapshot_governance()'",
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON FUNCTION public.clinical_continuity_assert_snapshot_governance()\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        "pg_catalog.to_regclass('public._migrations')",
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON TABLE public._migrations\n          FROM vhhealth_app',
      );
      expect(grantSql).toContain(
        'GRANT SELECT\n          ON TABLE public._migrations\n          TO vhhealth_app',
      );
      expect(grantSql).toContain(
        'REVOKE ALL PRIVILEGES\n          ON SEQUENCE public._migrations_id_seq\n          FROM vhhealth_app',
      );
      // Migration 764's own GRANT block runs once per database; this boot pass
      // re-grants SELECT, INSERT, UPDATE, DELETE on ALL tables first, so a
      // table missing from these lists silently keeps DELETE. Pin
      // patient_bloodborne_markers to the mutable-no-delete list (not the
      // append-only one — the void transition is an UPDATE).
      const mutableNoDelete = grantSql.match(
        /runtime_mutable_no_delete_relations CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n {2}\];/,
      );
      expect(mutableNoDelete).not.toBeNull();
      expect(mutableNoDelete[1]).toContain("'patient_bloodborne_markers'");
      const nextvalSequences = grantSql.match(
        /runtime_nextval_sequences CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\n {2}\];/,
      );
      expect(nextvalSequences).not.toBeNull();
      expect(nextvalSequences[1]).toContain("'patient_bloodborne_markers_id_seq'");
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Tenant RLS runtime role grants ensured',
        { role: 'vhhealth_app' },
      );
    });

    it('returns the error shape (and warns) when the grant DDL fails', async () => {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = 'vhhealth_app';
      const mod = await freshImport();
      const base = primaryBase();
      base.$executeRawUnsafe = jest.fn(() => Promise.reject(new Error('permission denied')));

      const result = await mod.ensureTenantRlsRuntimeRoleGrants();
      expect(result).toMatchObject({ skipped: false, role: 'vhhealth_app', error: 'permission denied' });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('runtime role grant pass failed'),
        expect.objectContaining({ role: 'vhhealth_app' }),
      );
    });
  });

  // ── graceful shutdown (beforeExit) ────────────────────────────────────

  describe('graceful shutdown', () => {
    it('disconnects only the primary when no replica is configured', async () => {
      const mod = await freshImport();
      const primary = allStubs[0];
      void mod;

      process.emit('beforeExit', 0);
      await new Promise((r) => setImmediate(r));
      expect(primary.$disconnect).toHaveBeenCalled();
    });

    it('disconnects both primary and replica when DATABASE_READ_URL is set', async () => {
      process.env.DATABASE_READ_URL = 'postgresql://test@replica/test';
      const mod = await freshImport();
      const primary = allStubs[0];
      const replica = allStubs[1];
      void mod;

      process.emit('beforeExit', 0);
      await new Promise((r) => setImmediate(r));
      expect(primary.$disconnect).toHaveBeenCalled();
      expect(replica.$disconnect).toHaveBeenCalled();
    });

    it('swallows a $disconnect error during shutdown', async () => {
      const mod = await freshImport();
      const primary = allStubs[0];
      primary.$disconnect = jest.fn(() => Promise.reject(new Error('already closed')));
      void mod;

      process.emit('beforeExit', 0);
      // Should not throw / reject — handler swallows.
      await new Promise((r) => setImmediate(r));
      expect(primary.$disconnect).toHaveBeenCalled();
    });
  });

  // ── prismaReadOnly wrapping ───────────────────────────────────────────

  describe('prismaReadOnly', () => {
    it('is a distinct wrapped client when DATABASE_READ_URL is set', async () => {
      process.env.DATABASE_READ_URL = 'postgresql://test@replica/test';
      const mod = await freshImport();
      expect(mod.prismaReadOnly).not.toBe(mod.default);
      // And it carries the circuit-breaker wrapper: a raw call works.
      const replica = allStubs[1];
      replica.$queryRawUnsafe = jest.fn(async () => [{ r: 1 }]);
      await expect(mod.prismaReadOnly.$queryRawUnsafe('SELECT 1')).resolves.toEqual([{ r: 1 }]);
    });
  });
});
