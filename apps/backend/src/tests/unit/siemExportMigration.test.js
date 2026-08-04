import fs, { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIG_448 = path.resolve(__dirname, '../../migrations/448_siem_export_targets.sql');
const MIG_449 = path.resolve(__dirname, '../../migrations/449_siem_export_events_deliveries.sql');
const MIG_622 = path.resolve(__dirname, '../../migrations/622_siem_canonical_cutover.sql');

describe('NL12-S2 SIEM export migrations', () => {
  let targetsSql;
  let eventsSql;
  let cutoverSql;

  beforeAll(() => {
    targetsSql = fs.readFileSync(MIG_448, 'utf8');
    eventsSql = fs.readFileSync(MIG_449, 'utf8');
    cutoverSql = fs.readFileSync(MIG_622, 'utf8');
  });

  it('retains the original SIEM tables and adds the canonical cutover at migration 622', () => {
    expect(path.basename(MIG_448)).toMatch(/^448_/);
    expect(path.basename(MIG_449)).toMatch(/^449_/);
    expect(path.basename(MIG_622)).toBe('622_siem_canonical_cutover.sql');
    const migrations = readdirSync(path.resolve(__dirname, '../../migrations'))
      .filter(name => /^\d+.*\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    expect(migrations[migrations.indexOf(path.basename(MIG_622)) - 1])
      .toBe('621_clinical_trial_catalog_recovery.sql');
    expect(cutoverSql).not.toMatch(/CREATE\s+TABLE/i);
    expect(cutoverSql).not.toMatch(/DROP\s+TABLE/i);
    for (const table of [
      'siem_export_targets',
      'siem_export_cursors',
      'siem_export_events',
      'siem_export_delivery_attempts',
    ]) {
      expect(cutoverSql).toMatch(new RegExp(`ALTER TABLE public\\.${table}`, 'i'));
    }
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

  it('records all ten cutover gates verbatim and never treats export_status as delivery truth', () => {
    for (const gate of [
      'stable fenced cutoff',
      'shape parity',
      'capture completeness (recomputed payload SHA-256 per row)',
      'per-target delivery completeness from attempt lineage (never export_status)',
      'real acknowledgement policy',
      'cursor equality only where gate 4 passes, else pause at the greatest proven contiguous point with a reconciliation reason',
      'non-destructive fenced cutover (old cursor/events/attempts remain queryable; migrate the existing SIEM cursor only after parity; never delete old evidence)',
      'single writer after cutover (legacy writer frozen, canonical offsets authoritative; never both)',
      'crash/restart injection proofs at every boundary',
      'negative migration proof (any mismatch aborts with zero partial canonical rows)',
    ]) {
      expect(cutoverSql).toContain(gate);
    }
    expect(cutoverSql).toContain('Legacy aggregate diagnostic only. Never use for per-target delivery');
  });

  it('requires fenced leases, owner-classified acknowledgement, and held late recovery', () => {
    expect(cutoverSql).toContain('chk_siem_export_delivery_attempts_lease');
    expect(cutoverSql).toContain('lease_generation >= 1');
    expect(cutoverSql).toContain("acknowledgement_state = 'positive'");
    expect(cutoverSql).toContain('chk_siem_export_targets_ack_owner_shape');
    expect(cutoverSql).toContain("send_authority = 'held_owner_reconciliation'");
    expect(cutoverSql).toContain("effect_disposition = 'late_pending_only'");
    expect(cutoverSql).toContain("capture_schedule_decision VARCHAR(48) NOT NULL DEFAULT 'owner_activation_required'");
  });
});
