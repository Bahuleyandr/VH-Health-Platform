// src/tests/unit/readinessRlsPosture.test.js
//
// Audit C-7: the readiness probe (GET /health/ready) must gate on runtime
// dependencies, NOT on tenant-RLS *security posture*. A bad RLS
// posture (e.g. a bypassing role / unforced table) used to make `ready` false
// on every replica → fleet-wide API outage from a security warning.
//
// These tests mount the real uptimeRoutes router with a fully-mocked prisma so
// we control both the DB probe (healthy) and the RLS posture (ok:false), and
// assert: DB ok + RLS posture flagged → 200. DB down → 503. No DB or supertest-
// against-app needed.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// --- prisma mock -------------------------------------------------------------
// $queryRaw is the tagged-template call used by /ready (migration probe) and
// /metrics (SELECT 1). Default: healthy migration row. Tests can override.
const queryRawMock = jest.fn();
const tenantRlsRolePostureMock = jest.fn();
const readMigrationStateMock = jest.fn();
const redisPingMock = jest.fn();
const assertRedisWritableMock = jest.fn();
const getRedisClientMock = jest.fn();
const redisIsRequiredMock = jest.fn();
const isWsFanoutReadyMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: { $queryRaw: queryRawMock, $queryRawUnsafe: queryRawMock },
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
  tenantRlsRolePosture: tenantRlsRolePostureMock,
}));

jest.unstable_mockModule('../../utils/migrations/runMigrations.js', () => ({
  readMigrationState: readMigrationStateMock,
}));

jest.unstable_mockModule('../../lib/redis.js', () => ({
  assertRedisWritable: assertRedisWritableMock,
  cacheClear: jest.fn(),
  cacheDelete: jest.fn(),
  cacheGet: jest.fn(async () => null),
  cacheSet: jest.fn(async () => true),
  disconnectRedis: jest.fn(),
  getRedisClient: getRedisClientMock,
  initRedis: jest.fn(),
  isRedisConfigured: jest.fn(() => false),
  isRedisConnected: jest.fn(() => false),
  parseSentinelHosts: jest.fn(() => []),
  redisIsRequired: redisIsRequiredMock,
  resolveRedisConnection: jest.fn(() => null),
}));

jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  isWsFanoutReady: isWsFanoutReadyMock,
}));

// The monitoring-access gate now fails CLOSED in every env (audit 2026-06-18
// §4): /health/ready + /health/metrics require a valid monitoring token even
// off-prod. Set a test token and send the matching x-monitoring-token header
// (the same pattern the k8s readiness probe uses — see
// infra/kubernetes/apps/backend/deployment.yaml). Import the router AFTER the
// mock is set.
const MONITORING_TOKEN = 'test-monitoring-token';
process.env.MONITORING_TOKEN = MONITORING_TOKEN;
const { default: uptimeRouter } = await import('../../routes/health/uptimeRoutes.js');

function makeApp() {
  const app = express();
  app.use('/health', uptimeRouter);
  return app;
}

const withToken = (req) => req.set('x-monitoring-token', MONITORING_TOKEN);

beforeEach(() => {
  queryRawMock.mockReset();
  tenantRlsRolePostureMock.mockReset();
  readMigrationStateMock.mockReset();
  redisPingMock.mockReset();
  assertRedisWritableMock.mockReset();
  getRedisClientMock.mockReset();
  redisIsRequiredMock.mockReset();
  isWsFanoutReadyMock.mockReset();
  queryRawMock.mockResolvedValue([{ exists: true }]);
  readMigrationStateMock.mockResolvedValue({
    requiredCurrent: true,
    expectedTip: '667_current.sql',
    executedTip: '667_current.sql',
    pending: [],
    unexpected: [],
  });
  redisPingMock.mockResolvedValue('PONG');
  assertRedisWritableMock.mockResolvedValue(true);
  getRedisClientMock.mockReturnValue({ ping: redisPingMock });
  redisIsRequiredMock.mockReturnValue(false);
  isWsFanoutReadyMock.mockReturnValue(true);
});

describe('GET /health/ready — RLS posture must NOT gate readiness (C-7)', () => {
  it('returns 200 when DB is reachable even if tenant-RLS posture is flagged inert', async () => {
    // RLS posture is bad (enforced but role bypasses RLS) — this previously
    // forced a 503 on every replica.
    tenantRlsRolePostureMock.mockResolvedValue({
      enforced: true,
      ok: false,
      reason: 'effective_role_bypasses_rls',
      effectiveRole: 'postgres',
    });

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.database.status).toBe('ok');
    // The readiness payload must not carry a tenant_rls gate at all.
    expect(res.body.checks.tenant_rls).toBeUndefined();
  });

  it('still returns 503 when the DB probe fails (reachability IS gated)', async () => {
    readMigrationStateMock.mockRejectedValueOnce(new Error('connection refused'));

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.database.status).toBe('error');
  });

  it('returns 503 when the image requires migrations absent from the database', async () => {
    readMigrationStateMock.mockResolvedValueOnce({
      requiredCurrent: false,
      expectedTip: '667_pending.sql',
      executedTip: '666_applied.sql',
      pending: ['667_pending.sql'],
      unexpected: [],
    });

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(503);
    expect(res.body.checks.migrations).toMatchObject({
      status: 'error',
      expected_tip: '667_pending.sql',
      pending_count: 1,
    });
  });

  it('keeps an old pod ready when an additive rolling deployment moves the database ahead', async () => {
    readMigrationStateMock.mockResolvedValueOnce({
      requiredCurrent: true,
      expectedTip: '666_old-image.sql',
      executedTip: '667_new-image.sql',
      pending: [],
      unexpected: ['667_new-image.sql'],
    });

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(200);
    expect(res.body.checks.migrations).toMatchObject({
      status: 'ok',
      database_ahead: true,
    });
  });

  it('does not even call tenantRlsRolePosture from the readiness path', async () => {
    tenantRlsRolePostureMock.mockResolvedValue({ enforced: false, ok: true });

    await withToken(request(makeApp()).get('/health/ready'));

    // Readiness no longer probes RLS posture at all.
    expect(tenantRlsRolePostureMock).not.toHaveBeenCalled();
  });

  it('gates on a writable Redis primary when strict Sentinel mode is required', async () => {
    redisIsRequiredMock.mockReturnValue(true);

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(200);
    expect(res.body.checks.redis.status).toBe('ok');
    expect(res.body.checks.redis_websocket_subscriber.status).toBe('ok');
    expect(assertRedisWritableMock).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when strict Redis is writable but its WS subscriber is unavailable', async () => {
    redisIsRequiredMock.mockReturnValue(true);
    isWsFanoutReadyMock.mockReturnValue(false);

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(503);
    expect(res.body.checks.redis.status).toBe('ok');
    expect(res.body.checks.redis_websocket_subscriber.status).toBe('error');
  });

  it('returns 503 when the strict Sentinel primary is not writable', async () => {
    redisIsRequiredMock.mockReturnValue(true);
    assertRedisWritableMock.mockRejectedValueOnce(new Error('NOREPLICAS'));

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(503);
    expect(res.body.checks.redis).toEqual({
      status: 'error',
      message: 'Required Redis check failed',
    });
  });
});

describe('GET /health/deep — Redis singleton wiring', () => {
  it('probes the initialized Redis singleton', async () => {
    const res = await withToken(request(makeApp()).get('/health/deep'));

    expect(res.status).toBe(200);
    expect(res.body.checks.redis.status).toBe('ok');
    expect(redisPingMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /health/metrics — RLS posture signal is retained (not lost)', () => {
  it('surfaces tenant_rls posture on the metrics endpoint', async () => {
    tenantRlsRolePostureMock.mockResolvedValue({
      enforced: true,
      ok: false,
      reason: 'effective_role_bypasses_rls',
    });

    const res = await withToken(request(makeApp()).get('/health/metrics'));

    expect(res.status).toBe(200);
    expect(res.body.tenant_rls).toEqual(
      expect.objectContaining({ enforced: true, ok: false, reason: 'effective_role_bypasses_rls' }),
    );
    expect(tenantRlsRolePostureMock).toHaveBeenCalled();
  });
});
