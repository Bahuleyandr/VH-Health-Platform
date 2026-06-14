// src/tests/unit/tenantContextCoverage.test.js
//
// Coverage-focused unit suite for src/lib/tenantContext.js (roadmap B3.2 — the
// RLS domain). The AsyncLocalStorage helpers are otherwise only exercised
// indirectly by prismaCoverage/deep RLS suites; this file drives each export
// directly with no mocks (the store is real, no DB is touched):
//   - runInTenantContext: tenantId visible inside fn, the null-tenantId path,
//     and the inSetTenant marker
//   - runWithSuperAdmin: superAdmin flag visible inside fn
//   - getCurrentTenantId / isSuperAdminContext / getCurrentTenantContext:
//     both inside-context and outside-context (null) branches

import { describe, it, expect } from '@jest/globals';
import {
  runInTenantContext,
  runWithSuperAdmin,
  getCurrentTenantId,
  isSuperAdminContext,
  getCurrentTenantContext,
} from '../../lib/tenantContext.js';

const TENANT = '00000000-0000-4000-8000-0000000000aa';

describe('tenantContext — outside any context', () => {
  it('returns null / false defaults when no context is active', () => {
    expect(getCurrentTenantId()).toBeNull();
    expect(isSuperAdminContext()).toBe(false);
    expect(getCurrentTenantContext()).toBeNull();
  });
});

describe('runInTenantContext', () => {
  it('exposes the tenantId to code running inside the callback', () => {
    const seen = runInTenantContext(TENANT, () => ({
      tenantId: getCurrentTenantId(),
      superAdmin: isSuperAdminContext(),
      ctx: getCurrentTenantContext(),
    }));
    expect(seen.tenantId).toBe(TENANT);
    expect(seen.superAdmin).toBe(false);
    expect(seen.ctx).toMatchObject({ tenantId: TENANT, superAdmin: false, inSetTenant: false });
  });

  it('normalises a falsy tenantId to null inside the context', () => {
    const tid = runInTenantContext('', () => getCurrentTenantId());
    expect(tid).toBeNull();
  });

  it('carries the inSetTenant marker when set', () => {
    const ctx = runInTenantContext(TENANT, () => getCurrentTenantContext(), { inSetTenant: true });
    expect(ctx.inSetTenant).toBe(true);
  });

  it('supports superAdmin via the options object', () => {
    const ctx = runInTenantContext(null, () => getCurrentTenantContext(), { superAdmin: true });
    expect(ctx.superAdmin).toBe(true);
    expect(ctx.tenantId).toBeNull();
  });

  it('returns an async callback result and clears context after it resolves', async () => {
    const result = await runInTenantContext(TENANT, async () => {
      expect(getCurrentTenantId()).toBe(TENANT);
      return 'done';
    });
    expect(result).toBe('done');
    // Context is per-run; it must not leak out after the callback resolves.
    expect(getCurrentTenantId()).toBeNull();
  });
});

describe('runWithSuperAdmin', () => {
  it('runs the callback under a tenant-less super-admin context', () => {
    const seen = runWithSuperAdmin(() => ({
      tenantId: getCurrentTenantId(),
      superAdmin: isSuperAdminContext(),
    }));
    expect(seen.tenantId).toBeNull();
    expect(seen.superAdmin).toBe(true);
  });
});
