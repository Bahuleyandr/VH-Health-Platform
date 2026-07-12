import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = (name) => path.resolve(__dirname, '../../migrations', name);
const seederPath = path.resolve(__dirname, '../../../scripts/seed-comprehensive-test-data.mjs');

const sql = {};

beforeAll(() => {
  sql.catalog = fs.readFileSync(migrationPath('563_cath_consumable_catalog.sql'), 'utf8');
  sql.usage = fs.readFileSync(migrationPath('564_cath_case_consumable_usage.sql'), 'utf8');
  sql.links = fs.readFileSync(migrationPath('565_cath_implant_inventory_links.sql'), 'utf8');
  sql.billing = fs.readFileSync(migrationPath('566_cath_consumables_billing_hook.sql'), 'utf8');
  sql.seeder = fs.readFileSync(seederPath, 'utf8');
});

describe('NL-13 P1d cath consumables migrations 563-566', () => {
  test('catalog bounds category/status and forces stents and implants to track batches', () => {
    for (const category of [
      'stent', 'balloon', 'guidewire', 'catheter', 'sheath',
      'closure_device', 'pacemaker', 'lead', 'other',
    ]) {
      expect(sql.catalog).toContain(`'${category}'`);
    }
    expect(sql.catalog).toMatch(/CHECK \(status IN \('active', 'retired'\)\)/i);
    expect(sql.catalog).toMatch(/CHECK \(category <> 'stent' OR batch_tracked\)/i);
    expect(sql.catalog).toMatch(/CHECK \(NOT is_implant OR batch_tracked\)/i);
    expect(sql.catalog).toMatch(
      /CHECK \(category NOT IN \('stent', 'pacemaker', 'lead'\) OR is_implant\)/i,
    );
  });

  test('usage requires lot evidence and expiry for batch-tracked rows', () => {
    expect(sql.usage).toMatch(
      /cath_consumable_usage_batch_expiry_check[\s\S]*NOT batch_tracked[\s\S]*BTRIM\(batch_number\)[\s\S]*BTRIM\(lot_number\)[\s\S]*expiry_date IS NOT NULL/i,
    );
    expect(sql.usage).toMatch(
      /FOREIGN KEY \(tenant_id, catalog_item_id, batch_tracked, is_implant\)[\s\S]*REFERENCES cath_consumable_catalog \(tenant_id, id, batch_tracked, is_implant\)/i,
    );
  });

  test('usage requires serial evidence for implants and a reason for wastage', () => {
    expect(sql.usage).toMatch(
      /cath_consumable_usage_implant_serial_check[\s\S]*CHECK \(NOT is_implant OR NULLIF\(BTRIM\(serial_number\), ''\) IS NOT NULL\)/i,
    );
    expect(sql.usage).toMatch(
      /cath_consumable_usage_waste_reason_check[\s\S]*CHECK \(NOT wasted OR NULLIF\(BTRIM\(waste_reason\), ''\) IS NOT NULL\)/i,
    );
    expect(sql.usage).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_consumable_usage_implant_serial[\s\S]*WHERE is_implant AND serial_number IS NOT NULL/i,
    );
  });

  test.each([
    ['catalog', 'cath_consumable_catalog'],
    ['usage', 'cath_case_consumable_usage'],
    ['billing', 'cath_consumables_billing_settings'],
  ])('%s table is tenant-scoped with forced RLS', (migration, table) => {
    expect(sql[migration]).toMatch(new RegExp(`tenant_id\\s+UUID`, 'i'));
    expect(sql[migration]).toMatch(new RegExp(`REFERENCES tenants\\(id\\)`, 'i'));
    expect(sql[migration]).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
    expect(sql[migration]).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
    expect(sql[migration]).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
    expect(sql[migration]).toMatch(/USING \([\s\S]*tenant_id = app_current_tenant_id_uuid\(\)[\s\S]*\)\s*WITH CHECK \(/i);
    expect(sql[migration].match(/tenant_id = app_current_tenant_id_uuid\(\)/gi)).toHaveLength(2);
  });

  test('patient-linked catalog and usage tables carry the GUC-aware tenant default', () => {
    for (const migration of ['catalog', 'usage', 'billing']) {
      expect(sql[migration]).toMatch(
        /tenant_id UUID NOT NULL DEFAULT COALESCE\([\s\S]*current_setting\('app\.current_tenant_id', true\)[\s\S]*00000000-0000-4000-8000-000000000001/i,
      );
    }
  });

  test('surgical implants accept exactly one OT or linked cath origin', () => {
    expect(sql.links).toMatch(/ALTER COLUMN ot_schedule_id DROP NOT NULL/i);
    expect(sql.links).toMatch(
      /FOREIGN KEY \(cath_case_id\) REFERENCES cath_lab_cases\(id\)/i,
    );
    expect(sql.links).toMatch(
      /FOREIGN KEY \(cath_usage_id\) REFERENCES cath_case_consumable_usage\(id\)/i,
    );
    expect(sql.links).toMatch(/CHECK \(num_nonnulls\(ot_schedule_id, cath_case_id\) = 1\)/i);
    expect(sql.links).toMatch(
      /cath_case_id IS NULL AND cath_usage_id IS NULL[\s\S]*cath_case_id IS NOT NULL AND cath_usage_id IS NOT NULL/i,
    );
    expect(sql.links).toMatch(
      /CREATE UNIQUE INDEX ux_surgical_implants_cath_usage[\s\S]*\(tenant_id, cath_usage_id, cath_case_id, patient_uid\)/i,
    );
    expect(sql.links).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ux_surgical_implants_cath_usage_id[\s\S]*\(cath_usage_id\)[\s\S]*WHERE cath_usage_id IS NOT NULL/i,
    );
    expect(sql.links).toMatch(
      /FOREIGN KEY \(tenant_id, cath_usage_id, cath_case_id, patient_uid\)[\s\S]*REFERENCES cath_case_consumable_usage \(tenant_id, id, case_id, patient_uid\)/i,
    );
    expect(sql.links).toMatch(/CHECK \(cath_case_id IS NULL OR patient_uid IS NOT NULL\)/i);
  });

  test('all cath links bind the referenced row to the same tenant and patient', () => {
    expect(sql.catalog).toMatch(
      /FOREIGN KEY \(tenant_id, inventory_item_id\)[\s\S]*REFERENCES pharmacy_inventory_items \(tenant_id, id\)/i,
    );
    expect(sql.usage).toMatch(
      /FOREIGN KEY \(tenant_id, case_id, patient_uid\)[\s\S]*REFERENCES cath_lab_cases \(tenant_id, id, patient_uid\)/i,
    );
    expect(sql.usage).toMatch(
      /FOREIGN KEY \(tenant_id, procedure_log_id, case_id, patient_uid\)[\s\S]*REFERENCES cath_procedure_logs \(tenant_id, id, case_id, patient_uid\)/i,
    );
    for (const [column, table] of [
      ['inventory_batch_id', 'pharmacy_inventory_batches'],
      ['inventory_movement_id', 'pharmacy_stock_movements'],
      ['timeline_event_id', 'clinical_timeline_events'],
      ['audit_event_id', 'clinical_audit_events'],
    ]) {
      expect(sql.usage).toMatch(
        new RegExp(`FOREIGN KEY \\(tenant_id, ${column}\\)[\\s\\S]*REFERENCES ${table} \\(tenant_id, id\\)`, 'i'),
      );
    }
  });

  test('inventory and billing emissions are idempotent by originating usage/log', () => {
    expect(sql.links).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_stock_movements_cath_usage[\s\S]*reference_type = 'cath_consumable_usage'/i,
    );
    expect(sql.billing).toMatch(
      /CREATE UNIQUE INDEX ux_billing_invoice_items_cath_procedure[\s\S]*\(tenant_id, source_ref_type, source_ref_id\)[\s\S]*source_ref_type = 'cath_procedure_log'[\s\S]*source_ref_active/i,
    );
    expect(sql.billing).toMatch(
      /CREATE UNIQUE INDEX ux_billing_invoice_items_cath_consumable[\s\S]*\(tenant_id, source_ref_type, source_ref_id\)[\s\S]*source_ref_type = 'cath_consumable_usage'[\s\S]*source_ref_active/i,
    );
    expect(sql.billing).toMatch(
      /DROP INDEX IF EXISTS ux_billing_invoice_items_dialysis_session[\s\S]*CREATE UNIQUE INDEX ux_billing_invoice_items_dialysis_session[\s\S]*\(tenant_id, source_ref_type, source_ref_id\)[\s\S]*source_ref_type = 'dialysis_session'[\s\S]*source_ref_active/i,
    );
    expect(sql.usage).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ux_cath_consumable_usage_idempotency[\s\S]*\(tenant_id, idempotency_key\)/i,
    );
    expect(sql.billing).toMatch(
      /ALTER COLUMN source_ref_id TYPE BIGINT[\s\S]*USING source_ref_id::bigint/i,
    );
    expect(sql.billing).toMatch(
      /UPDATE billing_invoice_items AS item[\s\S]*SET tenant_id = invoice\.tenant_id[\s\S]*FROM billing_invoices AS invoice[\s\S]*invoice\.id = item\.invoice_id[\s\S]*item\.tenant_id IS DISTINCT FROM invoice\.tenant_id/i,
    );
    expect(sql.billing).toMatch(
      /ADD COLUMN IF NOT EXISTS source_ref_active BOOLEAN NOT NULL DEFAULT TRUE[\s\S]*SET source_ref_active = NOT \([\s\S]*invoice\.status = 'VOID'[\s\S]*invoice\.issued_at IS NULL/i,
    );
    expect(sql.billing.indexOf('UPDATE billing_invoice_items AS item')).toBeLessThan(
      sql.billing.indexOf('CREATE UNIQUE INDEX ux_billing_invoice_items_dialysis_session'),
    );
  });

  test('the comprehensive seeder overrides conditional cath snapshots and implant origins', () => {
    expect(sql.seeder).toMatch(/TABLE_COLUMN_SEED_OVERRIDES[\s\S]*cath_case_consumable_usage/i);
    expect(sql.seeder).toMatch(/cath_case_consumable_usage[\s\S]*batch_tracked:\s*false/i);
    expect(sql.seeder).toMatch(/cath_case_consumable_usage[\s\S]*is_implant:\s*false/i);
    expect(sql.seeder).toMatch(/cath_case_consumable_usage[\s\S]*case_id:[\s\S]*cath_lab_cases/i);
    expect(sql.seeder).toMatch(/cath_case_consumable_usage[\s\S]*patient_uid:[\s\S]*cath_lab_cases/i);
    expect(sql.seeder).toMatch(/cath_case_consumable_usage[\s\S]*procedure_log_id:\s*null/i);
    expect(sql.seeder).toMatch(/surgical_implants[\s\S]*cath_case_id:\s*null/i);
    expect(sql.seeder).toMatch(/surgical_implants[\s\S]*cath_usage_id:\s*null/i);
  });
});
