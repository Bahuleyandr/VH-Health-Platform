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

import { evaluateTenantRlsPosture, tenantRlsRuntimeRole } from '../../lib/prisma.js';

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

  // Roadmap A2: the owner-exemption gap. CNPG prod connects as the table
  // OWNER (`vhhealth`, bootstrap.initdb.owner) — neither SUPERUSER nor
  // BYPASSRLS, so the rolsuper/rolbypassrls check passes, yet Postgres
  // exempts owners from any tenant_isolation policy that is not FORCEd.
  it('flags inert RLS when the effective role owns unforced tenant_isolation tables', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth',
      connectionBypassesRls: false,
      effectiveRoleOwnsUnforcedRlsTables: 11,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('owner_exempt_unforced_tables');
    expect(v.bypassesRls).toBe(false);
    expect(v.unforcedOwnedRlsTables).toBe(11);
    expect(v.effectiveRole).toBe('vhhealth');
  });

  it('is ok when the owner has zero unforced tenant_isolation tables (post-migration-272)', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth',
      connectionBypassesRls: false,
      effectiveRoleOwnsUnforcedRlsTables: 0,
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('enforced');
    expect(v.unforcedOwnedRlsTables).toBe(0);
  });

  it('bypass verdict wins over the owner-exemption verdict', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'postgres',
      connectionBypassesRls: true,
      effectiveRoleOwnsUnforcedRlsTables: 3,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('effective_role_bypasses_rls');
  });

  it('does not blame the runtime role for tables the CONNECTION role owns (runtime role owns nothing)', () => {
    // With a runtime role set, the probe counts tables owned by the runtime
    // role — not the connection role — because SET LOCAL ROLE makes the
    // runtime role the one RLS evaluates.
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth',
      connectionBypassesRls: false,
      testRole: 'vhhealth_app',
      testRoleBypassesRls: false,
      effectiveRoleOwnsUnforcedRlsTables: 0,
    });
    expect(v.ok).toBe(true);
    expect(v.effectiveRole).toBe('vhhealth_app');
  });

  // SEC-3 — read-replica posture. setTenant/setTenantTx { readOnly:true } route
  // tenant-scoped reads to the replica when DATABASE_READ_URL is configured, so
  // a SUPERUSER/BYPASSRLS replica role makes those reads inert even when the
  // primary is sound. These cases only fire when replicaProbed is true.
  it('ignores replica role facts entirely when no replica was probed', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth_app',
      connectionBypassesRls: false,
      // replicaProbed defaults false → single-DB deployment
      replicaConnectionRole: 'some_superuser',
      replicaConnectionBypassesRls: true,
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('enforced');
    expect(v.replicaEffectiveRole).toBeNull();
    expect(v.replicaBypassesRls).toBe(false);
  });

  it('flags inert replica RLS when the replica connection role bypasses (primary sound)', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth_app',
      connectionBypassesRls: false,
      replicaProbed: true,
      replicaConnectionRole: 'replica_super',
      replicaConnectionBypassesRls: true,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('replica_role_bypasses_rls');
    expect(v.effectiveRole).toBe('vhhealth_app'); // primary unaffected
    expect(v.replicaEffectiveRole).toBe('replica_super');
    expect(v.replicaBypassesRls).toBe(true);
  });

  it('is ok when both primary and replica connection roles are non-bypassing', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth_app',
      connectionBypassesRls: false,
      replicaProbed: true,
      replicaConnectionRole: 'vhhealth_app_ro',
      replicaConnectionBypassesRls: false,
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('enforced');
    expect(v.replicaEffectiveRole).toBe('vhhealth_app_ro');
    expect(v.replicaBypassesRls).toBe(false);
  });

  it('uses the runtime role as the replica effective role (SET LOCAL ROLE applies on the replica too)', () => {
    // Connection role on the replica bypasses, but a non-bypassing runtime role
    // is SET LOCAL ROLE'd before reads → replica is sound.
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth',
      connectionBypassesRls: true,
      testRole: 'vhhealth_app',
      testRoleBypassesRls: false,
      replicaProbed: true,
      replicaConnectionRole: 'replica_super',
      replicaConnectionBypassesRls: true,
      replicaTestRoleBypassesRls: false,
    });
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('enforced');
    expect(v.replicaEffectiveRole).toBe('vhhealth_app');
    expect(v.replicaBypassesRls).toBe(false);
  });

  it('primary bypass verdict wins over a replica bypass verdict', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'postgres',
      connectionBypassesRls: true,
      replicaProbed: true,
      replicaConnectionRole: 'replica_super',
      replicaConnectionBypassesRls: true,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('effective_role_bypasses_rls');
  });
});

describe('tenantRlsRuntimeRole', () => {
  it('prefers AUTH_TENANT_RLS_RUNTIME_ROLE over the legacy alias', () => {
    const role = tenantRlsRuntimeRole({
      AUTH_TENANT_RLS_RUNTIME_ROLE: 'vhhealth_app',
      AUTH_TENANT_RLS_TEST_ROLE: 'legacy_role',
    });
    expect(role).toBe('vhhealth_app');
  });

  it('falls back to the legacy AUTH_TENANT_RLS_TEST_ROLE alias', () => {
    const role = tenantRlsRuntimeRole({ AUTH_TENANT_RLS_TEST_ROLE: 'legacy_role' });
    expect(role).toBe('legacy_role');
  });

  it('returns null when neither env var is set (or both are blank)', () => {
    expect(tenantRlsRuntimeRole({})).toBeNull();
    expect(tenantRlsRuntimeRole({ AUTH_TENANT_RLS_RUNTIME_ROLE: '  ' })).toBeNull();
  });
});

// The pre-auth writers (Firebase first login, legacy register, the OTP register
// paths) run BEFORE the tenant middleware and outside setTenant/setTenantTx, so
// they execute as the bare CONNECTION role, never as the runtime role. A verdict
// that evaluates only `testRole || connectionRole` is blind to that path: it can
// report "posture OK" for vhhealth_app while every unscoped write to a FORCE-RLS
// table carrying a RESTRICTIVE policy (migration 758's explicit_tenant_context_753
// on users) is rejected 42501 for vhhealth_runtime. The verdict therefore also
// reports the connection role's own RLS status and how many such tables exist.
describe('evaluateTenantRlsPosture reports the bare connection role alongside the runtime role', () => {
  it('exposes the connection role as RLS-subject when a runtime role is configured', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth_runtime',
      connectionBypassesRls: false,
      testRole: 'vhhealth_app',
      testRoleBypassesRls: false,
      restrictiveForcedTables: 31,
    });
    expect(v.ok).toBe(true);
    expect(v.effectiveRole).toBe('vhhealth_app');
    expect(v.connectionRole).toBe('vhhealth_runtime');
    expect(v.connectionBypassesRls).toBe(false);
    expect(v.connectionRoleRlsSubject).toBe(true);
    expect(v.restrictiveForcedTables).toBe(31);
  });

  it('marks the connection role as not RLS-subject when it bypasses RLS (CI and rig superusers)', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'postgres',
      connectionBypassesRls: true,
      testRole: 'rls_test_app',
      testRoleBypassesRls: false,
      restrictiveForcedTables: 31,
    });
    expect(v.ok).toBe(true);
    expect(v.connectionRole).toBe('postgres');
    expect(v.connectionBypassesRls).toBe(true);
    expect(v.connectionRoleRlsSubject).toBe(false);
    expect(v.restrictiveForcedTables).toBe(31);
  });

  it('reports the connection role even without a runtime role, and defaults the table count to zero', () => {
    const v = evaluateTenantRlsPosture({
      enforced: true,
      connectionRole: 'vhhealth_runtime',
      connectionBypassesRls: false,
    });
    expect(v.ok).toBe(true);
    expect(v.connectionRole).toBe('vhhealth_runtime');
    expect(v.connectionRoleRlsSubject).toBe(true);
    expect(v.restrictiveForcedTables).toBe(0);
  });

  it('never calls the connection role RLS-subject while enforcement is disabled', () => {
    const v = evaluateTenantRlsPosture({
      enforced: false,
      connectionRole: 'vhhealth_runtime',
      connectionBypassesRls: false,
      restrictiveForcedTables: 31,
    });
    expect(v.connectionRoleRlsSubject).toBe(false);
    expect(v.restrictiveForcedTables).toBe(31);
  });
});
