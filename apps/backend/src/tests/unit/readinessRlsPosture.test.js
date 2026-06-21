// src/tests/unit/readinessRlsPosture.test.js
//
// Audit C-7: the readiness probe (GET /health/ready) must gate ONLY on DB
// reachability + schema, NOT on tenant-RLS *security posture*. A bad RLS
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

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: { $queryRaw: queryRawMock, $queryRawUnsafe: queryRawMock },
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
  tenantRlsRolePosture: tenantRlsRolePostureMock,
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
  // Default: healthy migration-106 probe.
  queryRawMock.mockResolvedValue([{ exists: true }]);
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
    queryRawMock.mockRejectedValueOnce(new Error('connection refused'));

    const res = await withToken(request(makeApp()).get('/health/ready'));

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.database.status).toBe('error');
  });

  it('does not even call tenantRlsRolePosture from the readiness path', async () => {
    tenantRlsRolePostureMock.mockResolvedValue({ enforced: false, ok: true });

    await withToken(request(makeApp()).get('/health/ready'));

    // Readiness no longer probes RLS posture at all.
    expect(tenantRlsRolePostureMock).not.toHaveBeenCalled();
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
