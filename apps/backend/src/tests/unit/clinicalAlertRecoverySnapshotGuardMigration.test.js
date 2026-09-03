import { readFileSync } from 'node:fs';

const guardDeclaration =
  /CREATE OR REPLACE FUNCTION public\.clinical_alert_delivery_recovery_escalation_snapshot_guard\(\)[\s\S]*?\n\$fn\$;/;

function migration(name) {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

function guardFunction(sql) {
  const match = sql.match(guardDeclaration);
  expect(match).not.toBeNull();
  return match[0];
}

describe('migration 761 clinical alert recovery escalation snapshot guard', () => {
  const migration759 = migration('759_fix_escalation_snapshot_guard_case.sql');
  const migration761 = migration('761_fix_clinical_alert_recovery_snapshot_rule_codes.sql');

  it('preserves the full 759 guard while replacing only the non-runtime rule codes', () => {
    const expected = guardFunction(migration759)
      .replaceAll(
        'clinical_alert_manual_hold_recovery',
        'clinical_alert_delivery_manual_hold_review',
      )
      .replaceAll(
        'clinical_alert_recipient_coverage_recovery',
        'clinical_alert_delivery_recipient_coverage',
      );

    expect(guardFunction(migration761)).toBe(expected);
  });

  it('fails closed for both real recovery rule codes and retains snapshot immutability', () => {
    const guard = guardFunction(migration761);

    expect(guard).toContain("'clinical_alert_delivery_manual_hold_review'");
    expect(guard).toContain("'clinical_alert_delivery_recipient_coverage'");
    expect(guard).not.toContain("'clinical_alert_manual_hold_recovery'");
    expect(guard).not.toContain("'clinical_alert_recipient_coverage_recovery'");
    expect(guard).toContain('clinical alert recovery escalation snapshot is immutable');
    expect(guard).toContain('clinical alert recovery escalation snapshot is incomplete');
    expect(guard).toContain(
      'clinical alert recovery escalation must notify the exact active recipient set',
    );
  });
});
