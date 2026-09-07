import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../migrations/768_reprocessable_devices_platform.sql', import.meta.url),
  'utf8',
);

const NEW_RELATIONS = [
  'reprocessing_domain_settings',
  'reprocessing_isolation_setting_revisions',
  'reprocessing_domain_policies',
  'reprocessing_protocols',
  'reprocessable_devices',
  'reprocessable_device_usages',
  'reprocessable_device_dialysis_links',
  'dialysis_machines',
  'reprocessable_device_holds',
  'device_processing_events',
  'dialyser_reprocessing_attempts',
  'bloodborne_exposure_outbox',
  'reprocessing_protocol_device_scopes',
  'device_processing_event_revisions',
  'reprocessable_hold_satisfactions',
  'bloodborne_exposure_deliveries',
  'bloodborne_exposure_applications',
  'reprocessable_device_operations',
];

describe('migration 768 Plan 4 schema foundation contract', () => {
  test('creates exactly the eighteen Plan 4 relations and leaves Phase 1 owners alone', () => {
    expect(NEW_RELATIONS).toHaveLength(18);
    const created = [...migration.matchAll(/CREATE TABLE public\.([a-z0-9_]+)/g)]
      .map((match) => match[1]);
    expect(created).toHaveLength(18);
    expect(created).toEqual(expect.arrayContaining(NEW_RELATIONS));
    expect(migration).not.toMatch(/ALTER TABLE public\.(dialysis_patients|patient_bloodborne_markers|cath_reprocessable_devices)/);
  });

  test('registers both RLS policies, FORCE RLS, and runtime ACLs for every relation', () => {
    expect(NEW_RELATIONS).toHaveLength(18);
    for (const relation of NEW_RELATIONS) {
      expect(migration).toContain(`'${relation}'`);
    }
    expect(migration).toContain('CREATE POLICY tenant_isolation');
    expect(migration).toContain('CREATE POLICY tenant_context_required');
    expect(migration).toContain('app_current_tenant_id_uuid() IS NOT NULL');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("ARRAY['vhhealth_app', 'vhhealth_runtime']::text[]");
  });

  test('pins the exact reuse matrix and tenant/device relationship constraints', () => {
    expect(migration).toContain('CONSTRAINT reprocessing_protocols_reuse_matrix_domain_check');
    expect(migration).toContain("reuse_matrix - ARRAY['hbsag', 'hcv', 'hiv', 'isolation_mixed']");
    expect(migration).toContain("reuse_matrix->>'hcv' IN ('no_reuse', 'dedicated_reuse')");
    expect(migration).toContain('FOREIGN KEY (tenant_id, current_usage_id, id)');
    expect(migration).toContain('REFERENCES public.reprocessable_device_usages (tenant_id, id, device_id)');
    expect(migration).toContain('FOREIGN KEY (tenant_id, device_usage_id, session_id)');
    expect(migration).toMatch(
      /CONSTRAINT fk_bloodborne_exposure_outbox_patient[\s\S]*?ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE/,
    );
  });
});
