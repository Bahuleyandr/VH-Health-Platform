import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function migration(name) {
  return fs.readFileSync(path.resolve(__dirname, '../../migrations', name), 'utf8');
}

describe('migrations 461-463 — public SMART + FHIR writes P1', () => {
  const migration461 = migration('461_smart_app_registration_policy.sql');
  const migration462 = migration('462_smart_launch_contexts.sql');
  const migration463 = migration('463_smart_fhir_write_resource_plan.sql');

  it('adds SMART app production approval and contract fields', () => {
    expect(migration461).toMatch(/ADD COLUMN IF NOT EXISTS registration_status/i);
    expect(migration461).toMatch(/ADD COLUMN IF NOT EXISTS approved_by UUID/i);
    expect(migration461).toMatch(/ADD COLUMN IF NOT EXISTS production_contract_ref TEXT/i);
    expect(migration461).toMatch(/smart_apps_registration_status_chk/i);
  });

  it('creates tenant-scoped one-time SMART launch contexts with RLS', () => {
    expect(migration462).toMatch(/CREATE TABLE IF NOT EXISTS smart_launch_contexts/i);
    expect(migration462).toMatch(/launch_token_hash VARCHAR\(128\) NOT NULL UNIQUE/i);
    expect(migration462).toMatch(/ALTER TABLE smart_launch_contexts ENABLE ROW LEVEL SECURITY/i);
    expect(migration462).toMatch(/CREATE POLICY tenant_isolation ON smart_launch_contexts/i);
  });

  it('declares the resource-by-resource SMART FHIR write plan', () => {
    expect(migration463).toMatch(/CREATE TABLE IF NOT EXISTS smart_fhir_write_resource_plan/i);
    expect(migration463).toMatch(/UNIQUE \(tenant_id, resource_type\)/i);
    expect(migration463).toMatch(/'Observation', 'active', 'patient\/Observation.write'/i);
    expect(migration463).toMatch(/'Patient', 'deferred', 'patient\/Patient.write'/i);
  });
});
