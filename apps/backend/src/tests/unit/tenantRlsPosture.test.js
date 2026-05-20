/**
 * Unit tests for evaluateTenantRlsPosture — the pure verdict behind the
 * boot-time tenant-RLS guard (logTenantRlsRolePosture) and the
 * /health/metrics `tenant_rls` field.
 *
 * Background: Postgres bypasses ALL row-level security for roles with
 * `rolsuper` or `rolbypassrls`, even under FORCE ROW LEVEL SECURITY
 * (migration 237). So AUTH_ENFORCE_TENANT_RLS=true is necessary but NOT
 * sufficient — if the effective DB role bypasses RLS, every
 * tenant_isolation policy is silently inert. This was empirically
 * confirmed on dalekdefender (bootstrap superuser `vhhealth`: a query
 * under a non-matching tenant GUC still returned all rows). Swarm finding
 * 2026-05-17-cross-tenant-rls-receptionist-2242cd96.
 *
 * The "effective role" is the AUTH_TENANT_RLS_TEST_ROLE target when set
 * (setTenant does SET LOCAL ROLE before the GUC), else the connection role.
 */

import { evaluateTenantRlsPosture } from '../../lib/prisma.js';

describe('evaluateTenantRlsPosture', () => {
  it('is ok when enforcement is disabled, regardless of role bypass', () => {
    const v = evaluateTenantRlsPosture({
      enforced: false,
      connectionRole: 'vhhealth',
      connectionBypassesRls: true,
    });
    expect(v.enforced).toBe(false);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('enforcement_disabled');
    expect(v.effectiveRole).toBe('vhhealth');
  });

  it('flags inert RLS when enforced but the connection role bypasses (no test role)', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth',
      connectionBypassesRls: true,
    });
    expect(v.enforced).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('effective_role_bypasses_rls');
    expect(v.effectiveRole).toBe('vhhealth');
    expect(v.bypassesRls).toBe(true);
  });

  it('is ok when enforced and the connection role does not bypass', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth_app',
      connectionBypassesRls: false,
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('enforced');
    expect(v.effectiveRole).toBe('vhhealth_app');
    expect(v.bypassesRls).toBe(false);
  });

  it('is ok when a non-bypassing test role overrides a bypassing connection role', () => {
    // dalekdefender shape: connect as bootstrap superuser, but SET LOCAL ROLE
    // to a non-super role for wrapped queries (AUTH_TENANT_RLS_TEST_ROLE).
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth',
      connectionBypassesRls: true,
      testRole: 'vhhealth_rls',
      testRoleBypassesRls: false,
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('enforced');
    expect(v.effectiveRole).toBe('vhhealth_rls');
    expect(v.bypassesRls).toBe(false);
  });

  it('flags inert RLS when the configured test role itself bypasses RLS', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth_app',
      connectionBypassesRls: false,
      testRole: 'some_superuser',
      testRoleBypassesRls: true,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('effective_role_bypasses_rls');
    expect(v.effectiveRole).toBe('some_superuser');
    expect(v.bypassesRls).toBe(true);
  });

  it('treats the test role as the effective role even when the connection role is safe', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth_app',
      connectionBypassesRls: false,
      testRole: 'vhhealth_rls',
      testRoleBypassesRls: false,
    });
    expect(v.effectiveRole).toBe('vhhealth_rls');
    expect(v.ok).toBe(true);
  });
});
