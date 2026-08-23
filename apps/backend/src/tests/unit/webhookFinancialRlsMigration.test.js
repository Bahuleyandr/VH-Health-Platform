// Shape pins for migration 726 (once-over 2026-08-23): the fail-closed
// restrictive RLS tranche over the webhook-fed PHI and financial tables.
// The migration text is immutable once applied, so these pins document the
// tranche's exact scope — including what was deliberately EXCLUDED.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const sql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../migrations/726_webhook_financial_explicit_tenant_rls.sql',
  ),
  'utf8',
);

const COVERED = [
  'abdm_hiu_fetch_sessions',
  'abdm_hiu_fetch_pages',
  'abdm_hiu_received_bundles',
  'abdm_patient_share_intakes',
  'abha_enrolment_sessions',
  'payment_gateway_orders',
  'payment_gateway_webhook_events',
  'payment_gateway_refunds',
  'payment_gateway_provider_configs',
];

describe('migration 726 — webhook/financial fail-closed RLS tranche', () => {
  it('covers exactly the verified-wrapped writer tables', () => {
    for (const table of COVERED) {
      expect(sql).toContain(`'${table}'`);
    }
  });

  it('uses the 669 idiom: ENABLE + FORCE + AS RESTRICTIVE explicit context', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('AS RESTRICTIVE');
    expect(sql).toContain("current_setting('app.current_tenant_id', true) <> 'bypass'");
    expect(sql).toContain('tenant_id = app_current_tenant_id_uuid()');
  });

  it('deliberately excludes the SMS pair until its service wraps in setTenantTx', () => {
    // Documented in the migration header and SCHEMA_NOTES — if these appear
    // in the loop, the exclusion decision changed and BOTH docs must move.
    const loop = sql.slice(sql.indexOf('FOREACH'));
    expect(loop).not.toContain("'sms_provider_configs'");
    expect(loop).not.toContain("'sms_template_registrations'");
  });
});
