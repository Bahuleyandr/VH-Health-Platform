import { readFileSync } from 'node:fs';

describe('Diagnostics rollout scripts', () => {
  const backfill = readFileSync(
    new URL('../../../scripts/backfill-structured-diagnostic-release-states.mjs', import.meta.url),
    'utf8',
  );
  const registration = readFileSync(
    new URL('../../../scripts/register-diagnostics-pathway-definition.mjs', import.meta.url),
    'utf8',
  );
  const shadowMode = readFileSync(
    new URL('../../../scripts/set-care-pathway-shadow-mode.mjs', import.meta.url),
    'utf8',
  );

  test('release-state backfill is tenant-scoped, dry-run by default, and never notifies', () => {
    expect(backfill).toContain("requireUuid('tenant-id')");
    expect(backfill).toContain("requireUuid('actor-uid')");
    expect(backfill).toContain("requiredText('reason')");
    expect(backfill).toContain("hasFlag('apply')");
    expect(backfill).toContain("hasFlag('acknowledge-patient-visibility')");
    expect(backfill).toContain('ON CONFLICT (generation_id) DO NOTHING');
    expect(backfill).toContain('patient_notifications_sent: 0');
    expect(backfill).toContain("'STRUCTURED_DIAGNOSTIC_RELEASE_STATE_BACKFILL'");
    expect(backfill).toContain("IN ('ADMIN', 'SUPER_ADMIN')");
    expect(backfill).not.toMatch(/INSERT INTO notification_outbox/i);
    expect(backfill).not.toMatch(/UPDATE\s+(radiology_orders|ap_reports)/i);
  });

  test('definition registration requires named owners, approver, and an explicit apply attestation', () => {
    expect(registration).toContain("requireUuid('clinical-owner-uid')");
    expect(registration).toContain("requireUuid('operational-owner-uid')");
    expect(registration).toContain("requireUuid('approver-uid')");
    expect(registration).toContain("requiredText('patient-visibility-policy-ref')");
    expect(registration).toContain("hasFlag('acknowledge-owner-sign-off')");
    expect(registration).toContain("['ADMIN', 'SUPER_ADMIN'].includes(actors.get(approverUid))");
    expect(registration).toContain('compiled.checksum');
    expect(registration).toContain("$6::uuid, NOW(), $7::text, $8::text");
    expect(registration).not.toContain('approval.rows[0].decided_at');
    expect(registration).not.toMatch(/UPDATE\s+tenants/i);
  });

  test('mode tooling is audited, tenant-scoped, and cannot activate a pathway', () => {
    expect(shadowMode).toContain("const ALLOWED_MODES = new Set(['off', 'shadow'])");
    expect(shadowMode).toContain("hasFlag('acknowledge-shadow-observation')");
    expect(shadowMode).toContain("new Set(['ADMIN', 'SUPER_ADMIN'])");
    expect(shadowMode).toContain("SELECT set_config('app.current_tenant_id'");
    expect(shadowMode).toContain("'CARE_PATHWAY_MODE_CHANGED'");
    expect(shadowMode).toContain('INSERT INTO audit_logs');
    expect(shadowMode).not.toMatch(/ALLOWED_MODES[^\n]+active/);
  });
});
