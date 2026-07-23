import { readFileSync } from 'node:fs';

describe('migration 593 diagnostic result notification receipts', () => {
  const source = readFileSync(
    new URL('../../migrations/593_structured_diagnostic_patient_notifications.sql', import.meta.url),
    'utf8',
  );

  test('is append-only, tenant-isolated, generation-scoped, and does not backfill', () => {
    expect(source).toContain('CREATE TABLE diagnostic_result_patient_notifications');
    expect(source).toContain('UNIQUE (tenant_id, generation_id, notification_kind)');
    expect(source).toContain('FOREIGN KEY (tenant_id, generation_id, patient_uid)');
    expect(source).toContain('FOREIGN KEY (tenant_id, notification_outbox_id)');
    expect(source).toContain('ENABLE ROW LEVEL SECURITY');
    expect(source).toContain('FORCE ROW LEVEL SECURITY');
    expect(source).toContain('WITH CHECK');
    expect(source).toContain('diagnostic_result_evidence_append_only()');
    expect(source).not.toMatch(/INSERT INTO diagnostic_result_patient_notifications/i);
  });
});
