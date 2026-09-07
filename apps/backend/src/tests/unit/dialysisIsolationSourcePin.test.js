import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..', '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(BACKEND, relativePath), 'utf8');
}

describe('dialysis isolation source pins', () => {
  test('enrolment and migration 767 stop manufacturing negative declarations', () => {
    const dialysisService = source('src/services/clinical/dialysisService.js');
    const migration = source('src/migrations/767_dialysis_isolation_resolver.sql');
    const enrolment = dialysisService.slice(
      dialysisService.indexOf('export async function enrolPatient'),
      dialysisService.indexOf('export async function listPatients'),
    );
    expect(enrolment).toContain("COALESCE($8,  'unknown')");
    expect(enrolment).toContain("COALESCE($9,  'unknown')");
    expect(enrolment).toContain("COALESCE($10, 'unknown')");
    expect(enrolment).not.toMatch(/COALESCE\(\$(?:8|9|10),\s*'negative'\)/);
    expect(migration.match(/ALTER COLUMN (?:hbsag|hcv|hiv)_status SET DEFAULT 'unknown'/g)).toHaveLength(3);
  });

  test('migration 767 repairs and enforces the serology tenant relationship', () => {
    const migration = source('src/migrations/767_dialysis_isolation_resolver.sql');
    expect(migration).toContain('serology.tenant_id IS DISTINCT FROM patient.tenant_id');
    expect(migration).toMatch(/FOREIGN KEY \(tenant_id, dialysis_patient_id\)[\s\S]*REFERENCES dialysis_patients \(tenant_id, id\)/);
    expect(migration).toMatch(/UNIQUE \(tenant_id, id\)[\s\S]*patient_bloodborne_markers/s);
  });

  test('the adapter has no legacy-column fallback and is the resolver module binding', () => {
    const adapter = source('src/services/clinical/dialysisIsolationAdapter.js');
    expect(adapter).not.toMatch(/dialysis_patients|hbsag_status|hcv_status|hiv_status/);
    expect(adapter).toContain("import('./dialysisIsolationResolver.js')");

    const clinicalDir = path.join(BACKEND, 'src', 'services', 'clinical');
    const directBindings = fs.readdirSync(clinicalDir)
      .filter((name) => name.endsWith('.js'))
      .filter((name) => source(`src/services/clinical/${name}`).includes("'./dialysisIsolationResolver.js'"));
    expect(directBindings).toEqual(['dialysisIsolationAdapter.js']);
  });
});
