import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../migrations');

function migration(name) {
  return readFileSync(resolve(migrationsDir, name), 'utf8');
}

describe('cold-chain migrations', () => {
  const m391 = migration('391_cold_chain_units.sql');
  const m392 = migration('392_cold_chain_excursions.sql');
  const m393 = migration('393_cold_chain_alerting.sql');

  it('uses only the assigned 391-393 migration block for cold-chain tables', () => {
    expect(m391).toContain('CREATE TABLE IF NOT EXISTS cold_chain_units');
    expect(m391).toContain('CREATE TABLE IF NOT EXISTS cold_chain_readings');
    expect(m392).toContain('CREATE TABLE IF NOT EXISTS cold_chain_excursions');
    expect(m393).toContain('cold_chain_excursion_ack');
  });

  it('tenant-scopes cold-chain tables with RLS policies', () => {
    for (const sql of [m391, m392]) {
      expect(sql).toContain('tenant_id UUID NOT NULL');
      expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
      expect(sql).toContain('FORCE ROW LEVEL SECURITY');
      expect(sql).toContain('CREATE POLICY tenant_isolation');
      expect(sql).toContain('app_current_tenant_id_uuid()');
    }
  });

  it('requires corrective action before an excursion can close', () => {
    expect(m392).toContain('cold_chain_excursions_corrective_close_check');
    expect(m392).toContain("status <> 'closed'");
    expect(m392).toContain('corrective_action IS NOT NULL');
  });

  it('keeps results-inbox out of the facility-scoped cold-chain alert path', () => {
    const all = [m391, m392, m393].join('\n').toLowerCase();
    expect(all).not.toContain('results_inbox');
  });
});
