import { readFileSync, readdirSync } from 'node:fs';

const migrationSql = readFileSync(
  new URL('../../migrations/627_clinical_continuity_device_loss_orchestration.sql', import.meta.url),
  'utf8',
).replaceAll('\r\n', '\n');
const schema = readFileSync(
  new URL('../../../prisma/schema.prisma', import.meta.url),
  'utf8',
);

describe('migration 627 clinical continuity device-loss orchestration', () => {
  test('owns the freshly reserved slot and only three workflow projections', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => name.startsWith('627_'));
    expect(names).toEqual(['627_clinical_continuity_device_loss_orchestration.sql']);
    expect(migrationSql.match(/CREATE TABLE public\.clinical_continuity_device_loss_/g)).toHaveLength(3);
    expect(migrationSql).not.toMatch(/CREATE TABLE public\..*(?:audit|event|ledger)/i);
    expect(migrationSql.replace(/\r?\n--\s*/g, ' ')).toContain(
      'clinical_audit_events hash chain remains the one append-only business audit trail',
    );
  });

  test('pins Section 6.8 composite integrity, forced RLS, and approved retention', () => {
    for (const table of [
      'clinical_continuity_device_loss_operations',
      'clinical_continuity_device_loss_subjects',
      'clinical_continuity_device_loss_routes',
    ]) {
      expect(migrationSql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      expect(migrationSql).toContain(`'${table}'`);
      expect(schema).toContain(`model ${table}`);
    }
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, facility_id)');
    expect(migrationSql).toContain('REFERENCES public.facilities(tenant_id, id)');
    expect(migrationSql).toContain('FOREIGN KEY (tenant_id, staff_uid)');
    expect(migrationSql).toContain('REFERENCES public.users(tenant_id, uid)');
    expect(migrationSql).toContain("tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid");
    expect(migrationSql).toContain("INTERVAL '365 days'");
  });

  test('denies direct runtime updates and exposes only typed transition functions', () => {
    expect(migrationSql).toContain(
      "'REVOKE UPDATE, DELETE, TRUNCATE '" +
      "\n      'ON public.clinical_continuity_device_loss_operations FROM %I'",
    );
    for (const fn of [
      'clinical_continuity_device_loss_subject_identity_finalize',
      'clinical_continuity_device_loss_subject_token_record',
      'clinical_continuity_device_loss_phase1_finalize',
      'clinical_continuity_device_loss_step_failed',
      'clinical_continuity_device_loss_tokens_finalize',
      'clinical_continuity_device_loss_wipe_finalize',
      'clinical_continuity_device_loss_routing_finalize',
    ]) {
      expect(migrationSql).toContain(`CREATE FUNCTION public.${fn}`);
      expect(migrationSql).toContain('SECURITY DEFINER');
      expect(migrationSql).toContain('SET search_path = pg_catalog, pg_temp');
      expect(migrationSql).toContain(`REVOKE ALL PRIVILEGES ON FUNCTION public.${fn}`);
    }
  });

  test('preserves immutable order identity and exact C-D6 fallback routing', () => {
    expect(migrationSql).toContain('NEW.wipe_order_id IS DISTINCT FROM OLD.wipe_order_id');
    expect(migrationSql).toContain('OLD.wipe_content IS NOT NULL');
    expect(migrationSql).toContain("fallback_principal = 'role:clinical_safety_lead'");
    expect(migrationSql).toContain('device-loss standing routes are append-only');
    expect(migrationSql).toContain("wipe_signature ~ '^[A-Za-z0-9+/]{86}==$'");
  });
});
