import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIG_448 = path.resolve(__dirname, '../../migrations/448_siem_export_targets.sql');
const MIG_449 = path.resolve(__dirname, '../../migrations/449_siem_export_events_deliveries.sql');

describe('NL12-S2 SIEM export migrations', () => {
  let targetsSql;
  let eventsSql;

  beforeAll(() => {
    targetsSql = fs.readFileSync(MIG_448, 'utf8');
    eventsSql = fs.readFileSync(MIG_449, 'utf8');
  });

  it('uses only the assigned migration numbers for the SIEM tables', () => {
    expect(path.basename(MIG_448)).toMatch(/^448_/);
    expect(path.basename(MIG_449)).toMatch(/^449_/);
  });

  it.each([
    ['siem_export_targets', () => targetsSql],
    ['siem_export_cursors', () => targetsSql],
    ['siem_export_events', () => eventsSql],
    ['siem_export_delivery_attempts', () => eventsSql],
  ])('declares %s with tenant RLS and forced isolation', (table, sqlFor) => {
    const sql = sqlFor();
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
    expect(sql).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
    expect(sql).toContain('tenant_id = app_current_tenant_id_uuid()');
  });

  it('keeps the target contract transport-configured and owner-gated', () => {
    expect(targetsSql).toContain("transport IN ('webhook', 'syslog', 'object_drop')");
    expect(targetsSql).toContain("status IN ('draft', 'active', 'paused', 'retired')");
    expect(targetsSql).toContain('siem_export_targets_active_config_check');
    expect(targetsSql).toContain('operator_target_required');
  });

  it('requires minimized payload snapshots and blocks raw payload flags', () => {
    expect(eventsSql).toContain('siem_export_events_no_raw_payload_check');
    expect(eventsSql).toContain('siem_export_delivery_attempts_no_raw_payload_check');
    expect(eventsSql).toContain('raw clinical payloads are not exported by default');
    expect(eventsSql).toContain("severity IN ('high', 'critical')");
  });
});
