// src/tests/unit/probeDbBudget.test.js
//
// Incident 2026-09-09 06:40Z: `GET /` runs a real `SELECT 1` through the
// Prisma pool. A boot-time scheduled-job storm saturated that pool, the query
// sat behind 1.1-1.7 s scans, and the request never completed inside the
// kubelet's 1 s probe budget — so the readiness probe recorded a deadline
// instead of a verdict and the pod went NotReady.
//
// The probe now carries its own, shorter budget: a saturated pool produces a
// fast, truthful 503 rather than an unanswered request. These tests pin the
// budget behaviour and the fact that app.js consumes the shared helper instead
// of its own unbounded copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import * as espree from 'espree';
import {
  DEFAULT_PROBE_DB_TIMEOUT_MS,
  probeDb,
  resolveProbeDbTimeoutMs,
} from '../../utils/probeDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = path.resolve(__dirname, '../../app.js');

/** Prisma double whose `$queryRaw` tagged template resolves/rejects on demand. */
function prismaStub(behaviour) {
  const calls = [];
  return {
    calls,
    $queryRaw: (...args) => {
      calls.push(args);
      return behaviour();
    },
  };
}

describe('probeDb budget', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves true when the pool answers inside the budget', async () => {
    const prisma = prismaStub(() => Promise.resolve([{ '?column?': 1 }]));
    await expect(probeDb({ prisma, timeoutMs: 50 })).resolves.toBe(true);
    expect(prisma.calls).toHaveLength(1);
  });

  it('resolves false when the query rejects', async () => {
    const prisma = prismaStub(() => Promise.reject(new Error('connection refused')));
    await expect(probeDb({ prisma, timeoutMs: 50 })).resolves.toBe(false);
  });

  it('resolves false — instead of waiting for the pool — once the budget expires', async () => {
    jest.useFakeTimers();
    // A query that NEVER settles: the pre-fix probe returned only when the
    // pool did, which is exactly the 06:40Z failure. With a budget the probe
    // must answer on its own.
    const prisma = prismaStub(() => new Promise(() => {}));
    const pending = probeDb({ prisma, timeoutMs: 2000 });

    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toBe(false);
  });

  it('answers before the kubelet 5 s probe timeout at the shipped default budget', async () => {
    jest.useFakeTimers();
    const prisma = prismaStub(() => new Promise(() => {}));
    const pending = probeDb({ prisma, env: {} });

    // Advance to just under the readiness probe's timeoutSeconds: 5 window.
    await jest.advanceTimersByTimeAsync(4999);
    await expect(pending).resolves.toBe(false);
    expect(DEFAULT_PROBE_DB_TIMEOUT_MS).toBeLessThan(5000);
  });

  it('swallows a late rejection from the losing query instead of leaking it', async () => {
    jest.useFakeTimers();
    let rejectQuery;
    const prisma = prismaStub(() => new Promise((_resolve, reject) => { rejectQuery = reject; }));
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = probeDb({ prisma, timeoutMs: 100 });
      await jest.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toBe(false);
      // The pool finally gives up, long after the probe answered. www.js turns
      // an unhandledRejection into a graceful shutdown, so this must not leak.
      rejectQuery(new Error('pool timeout, reported late'));
      jest.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('reads the budget from PROBE_DB_TIMEOUT_MS and falls back on junk', () => {
    expect(resolveProbeDbTimeoutMs({})).toBe(DEFAULT_PROBE_DB_TIMEOUT_MS);
    expect(resolveProbeDbTimeoutMs({ PROBE_DB_TIMEOUT_MS: '750' })).toBe(750);
    expect(resolveProbeDbTimeoutMs({ PROBE_DB_TIMEOUT_MS: '0' })).toBe(0);
    expect(resolveProbeDbTimeoutMs({ PROBE_DB_TIMEOUT_MS: 'soon' }))
      .toBe(DEFAULT_PROBE_DB_TIMEOUT_MS);
    expect(resolveProbeDbTimeoutMs({ PROBE_DB_TIMEOUT_MS: '-5' }))
      .toBe(DEFAULT_PROBE_DB_TIMEOUT_MS);
  });

  it('keeps the unbounded path available when the budget is explicitly disabled', async () => {
    const prisma = prismaStub(() => Promise.resolve([1]));
    await expect(probeDb({ prisma, timeoutMs: 0 })).resolves.toBe(true);
  });
});

describe('app.js root probe wiring', () => {
  const source = fs.readFileSync(APP_PATH, 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true });

  it('imports the budgeted probe helper', () => {
    const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
    // Population guard: an empty import list would make the match below vacuous.
    expect(imports.length).toBeGreaterThan(10);
    const probeImport = imports.find((node) => node.source.value === './utils/probeDb.js');
    expect(probeImport).toBeDefined();
    const names = probeImport.specifiers.map((s) => s.local.name);
    expect(names).toContain('probeDb');
  });

  it('no longer declares its own unbounded probeDb', () => {
    const localDeclarations = [];
    const walk = (node) => {
      if (!node || typeof node.type !== 'string') { return; }
      if (node.type === 'FunctionDeclaration' && node.id?.name === 'probeDb') {
        localDeclarations.push(node.loc.start.line);
      }
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) { value.forEach(walk); } else if (value && typeof value.type === 'string') { walk(value); }
      }
    };
    walk(ast);
    expect(localDeclarations).toEqual([]);
    // Second, differently-constructed signal: the old body is gone from the
    // text too, so a rename could not make the AST check pass vacuously.
    expect(source).not.toContain('await prisma.$queryRaw`SELECT 1`');
  });
});
