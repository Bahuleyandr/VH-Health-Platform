import { readFileSync } from 'node:fs';

// apps/backend/.gitattributes pins *.js/*.mjs/*.json/*.yml to LF but not
// *.sql, so a Windows checkout hands this file back with CRLF endings and the
// multi-line GRANT/REVOKE assertions below — which spell their newlines as
// '\n' — miss on every Windows host while passing in CI. Line endings are not
// part of the grant contract, so normalise them on read and let the
// assertions keep matching the exact multi-line shape.
const migration = readFileSync(
  new URL('../../migrations/736_bounded_cross_tenant_expiry_sweeps.sql', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const prismaSource = readFileSync(new URL('../../lib/prisma.js', import.meta.url), 'utf8');
const serviceSources = [
  '../../services/abdm/abhaEnrolmentService.js',
  '../../services/abdm/abdmShareIntakeService.js',
  '../../services/billing/paymentGatewayService.js',
].map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8'));

const ROUTINES = [
  'sweep_expired_abha_enrolment_sessions',
  'sweep_expired_abdm_share_intakes',
  'sweep_expired_payment_gateway_orders',
];

function routineDefinition(name) {
  const start = migration.indexOf(`CREATE FUNCTION public.${name}()`);
  const end = migration.indexOf(`$${name}$;`, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('migration 736 bounded system-job capabilities', () => {
  it('restores the three restrictive policies without trusting a custom GUC', () => {
    const policyStart = migration.indexOf('DO $bounded_sweep_restore_explicit_tenant_policy$');
    const policyEnd = migration.indexOf('DROP FUNCTION IF EXISTS', policyStart);
    const policy = migration.slice(policyStart, policyEnd);

    for (const table of [
      'abha_enrolment_sessions',
      'abdm_patient_share_intakes',
      'payment_gateway_orders',
    ]) {
      expect(policy).toContain(`'${table}'`);
    }
    expect(policy).toContain('AS RESTRICTIVE');
    expect(policy).toContain("<> 'bypass'");
    expect(policy).toContain('tenant_id = public.app_current_tenant_id_uuid()');
    expect(policy).not.toContain('app.rls_system_job');
  });

  it('creates exactly three parameterless, locked SECURITY DEFINER routines', () => {
    expect(migration.match(/CREATE FUNCTION public\.sweep_expired_[a-z_]+\(\)/g))
      .toHaveLength(3);
    for (const routine of ROUTINES) {
      const definition = routineDefinition(routine);
      expect(definition).toContain('RETURNS INTEGER');
      expect(definition).toContain('SECURITY DEFINER');
      expect(definition).toContain('SET search_path = pg_catalog, pg_temp');
      expect(definition).toContain('SET row_security = off');
      expect(definition).not.toMatch(/\$[1-9][0-9]*/);
    }
  });

  it('hardcodes only the three existing expiry transitions', () => {
    const abha = routineDefinition(ROUTINES[0]);
    expect(abha).toContain('UPDATE public.abha_enrolment_sessions');
    expect(abha).toContain("status IN ('initiated', 'otp_sent', 'otp_verifying', 'otp_verified')");
    expect(abha).toContain("SET status = 'expired'");
    expect(abha).toContain('verification_claim_id = NULL');
    expect(abha).toContain('resend_claim_id = NULL');

    const share = routineDefinition(ROUTINES[1]);
    expect(share).toContain('UPDATE public.abdm_patient_share_intakes');
    expect(share).toContain("status = 'received'");
    expect(share).toContain("SET status = 'expired'");

    const payment = routineDefinition(ROUTINES[2]);
    expect(payment).toContain('UPDATE public.payment_gateway_orders');
    expect(payment).toContain("status IN ('created', 'attempted')");
    expect(payment).toContain("SET status = 'expired'");
  });

  it('requires a privileged PreSync owner and exposes execute only to runtime roles', () => {
    expect(migration).toContain('routine_owner IS DISTINCT FROM CURRENT_USER');
    expect(migration).toContain('role.rolsuper OR role.rolbypassrls');
    expect(migration).toContain('wait-owner-bypassrls initContainer');
    expect(migration).toContain("ARRAY['vhhealth_app', 'vhhealth_runtime']");
    for (const routine of ROUTINES) {
      expect(migration).toContain(
        `REVOKE ALL PRIVILEGES\n  ON FUNCTION public.${routine}()\n  FROM PUBLIC`,
      );
      expect(migration).toContain(
        `GRANT EXECUTE ON FUNCTION public.${routine}() TO %I`,
      );
    }
  });

  it('removes the generic system-job transaction capability from application code', () => {
    expect(prismaSource).not.toContain('SYSTEM_JOB_SWEEP_GUC_VALUE');
    expect(prismaSource).not.toContain('setSystemJobTx');
    expect(prismaSource).not.toContain("set_config('app.rls_system_job'");
    for (const source of serviceSources) {
      expect(source).not.toContain('setSystemJobTx');
      expect(source).not.toContain("UPDATE abha_enrolment_sessions\n        SET status = 'expired'");
      expect(source).not.toContain("UPDATE abdm_patient_share_intakes\n        SET status = 'expired'");
      expect(source).not.toContain("UPDATE payment_gateway_orders\n        SET status = 'expired'");
    }
  });
});
