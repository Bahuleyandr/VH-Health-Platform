import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../../migrations/767_dialysis_isolation_resolver.sql', import.meta.url),
  'utf8',
);
const service = fs.readFileSync(
  new URL('../../services/clinical/dialysisService.js', import.meta.url),
  'utf8',
);
const schema = fs.readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');

describe('migration 767 dialysis isolation source contract', () => {
  it('stops manufacturing legacy negatives without rewriting historical declarations', () => {
    for (const column of ['hbsag_status', 'hcv_status', 'hiv_status']) {
      expect(migration).toMatch(new RegExp(`ALTER COLUMN ${column} SET DEFAULT 'unknown'`));
    }
    expect(service).toMatch(/COALESCE\(\$8,\s*'unknown'\).*COALESCE\(\$9,\s*'unknown'\)/s);
    expect(service).toMatch(/COALESCE\(\$10,\s*'unknown'\)/);
    expect(migration).not.toMatch(/UPDATE\s+dialysis_patients/i);
    expect(schema.match(/_status\s+String\?\s+@default\("unknown"\)/g)).toHaveLength(3);
  });

  it('provides the tenant-pinned marker parent key reserved for Plan 4', () => {
    expect(migration).toMatch(
      /ALTER TABLE patient_bloodborne_markers[\s\S]*UNIQUE \(tenant_id, id\)/,
    );
    expect(schema).toContain(
      '@@unique([tenant_id, id], map: "uq_patient_bloodborne_markers_tenant_id_id")',
    );
  });
});
