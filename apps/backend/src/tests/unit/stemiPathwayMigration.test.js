import { readFileSync } from 'node:fs';

function migration(number, name) {
  return readFileSync(new URL(`../../migrations/${number}_${name}.sql`, import.meta.url), 'utf8');
}

describe('NL-13 P1c STEMI migration contracts', () => {
  const activations = migration(558, 'stemi_activations');
  const events = migration(559, 'stemi_pathway_events');
  const settings = migration(560, 'stemi_pathway_settings');
  const notifications = migration(561, 'stemi_team_notifications');
  const pendingSla = migration(562, 'workflow_sla_targets_pending');
  const service = readFileSync(
    new URL('../../services/clinical/stemiPathwayService.js', import.meta.url),
    'utf8',
  );

  test.each([
    ['stemi_activations', activations],
    ['stemi_pathway_events', events],
    ['stemi_pathway_settings', settings],
    ['stemi_team_notifications', notifications],
  ])('%s is tenant-scoped with forced RLS and bidirectional policy checks', (table, sql) => {
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    expect(sql).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    expect(sql).toMatch(/USING\s*\(/);
    expect(sql).toMatch(/WITH CHECK\s*\(/);
  });

  it('allows a genuinely pending pre-hospital door clock without weakening ED clocks', () => {
    expect(activations).toMatch(/door_time_at TIMESTAMPTZ\(6\),/);
    expect(activations).toMatch(/activation_source = 'prehospital_handover'[\s\S]*door_time_at IS NOT NULL/);
    expect(pendingSla).toMatch(/ALTER COLUMN started_at DROP NOT NULL/);
    expect(pendingSla).toMatch(/clock_start_pending/);
    expect(pendingSla).toMatch(/source_table = 'stemi_activations'/);
    expect(pendingSla).toMatch(/'stemi_door_to_ecg'[\s\S]*'stemi_door_to_balloon'/);
    expect(pendingSla).toMatch(/metadata @> '\{"clock_start_pending": true\}'/);
  });

  it('creates all three clocks fail-closed when owner targets are missing', () => {
    expect(service).toMatch(/'stemi_door_to_ecg'::text, \$10::int/);
    expect(service).toMatch(/'stemi_door_to_lab'::text, \$11::int/);
    expect(service).toMatch(/'stemi_door_to_balloon'::text, \$12::int/);
    expect(service).toMatch(/CASE WHEN targets\.target_minutes IS NULL THEN NULL/);
    expect(service).toMatch(/'targets_pending', targets\.target_minutes IS NULL/);
    expect(service).toMatch(/'clock_start_pending', \$6::timestamptz IS NULL/);
    expect(service).toMatch(/'door_time_pending', \$6::timestamptz IS NULL/);
    expect(service).toMatch(/WHEN due_at IS NOT NULL AND \$4::timestamptz > due_at THEN 'breached'/);
    expect(pendingSla).toMatch(/targets_pending_not_breached_chk/);
    expect(pendingSla).toMatch(/status <> 'breached' AND breached_at IS NULL/);
  });

  it('limits fan-out settings to canonical cath-lab roles', () => {
    expect(settings).toMatch(/notification_role_codes <@ ARRAY\['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'\]/);
    expect(service).toMatch(/CATH_NOTIFICATION_ROLE_CODES/);
  });

  it('stamps the trusted tenant explicitly on notification outbox inserts', () => {
    expect(service).toMatch(
      /INSERT INTO notification_outbox\s*\(tenant_id, type,[\s\S]*VALUES \(\$1::uuid, 'push'/,
    );
  });

  it('keeps pathway events append-only and ordered', () => {
    expect(events).toMatch(/sequence_number INTEGER NOT NULL/);
    expect(events).toMatch(/ON stemi_pathway_events \(tenant_id, activation_id, sequence_number\)/);
    expect(events).toMatch(/'stemi_pathway_events is append-only:/);
  });
});
