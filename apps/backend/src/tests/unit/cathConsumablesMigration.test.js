import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = (name) => path.resolve(__dirname, '../../migrations', name);
const seederPath = path.resolve(__dirname, '../../../scripts/seed-comprehensive-test-data.mjs');
const coveragePolicyPath = path.resolve(__dirname, '../../db/seedCoveragePolicy.js');
const prismaSchemaPath = path.resolve(__dirname, '../../../prisma/schema.prisma');

// These files are committed with LF, but core.autocrlf checks them out as CRLF
// on Windows. Read the canonical (committed) bytes so an assertion that spells
// a line break as `\n` means exactly the same thing on every host.
const readCanonical = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

const sql = {};

beforeAll(() => {
  sql.catalog = readCanonical(migrationPath('563_cath_consumable_catalog.sql'));
  sql.usage = readCanonical(migrationPath('564_cath_case_consumable_usage.sql'));
  sql.links = readCanonical(migrationPath('565_cath_implant_inventory_links.sql'));
  sql.billing = readCanonical(migrationPath('566_cath_consumables_billing_hook.sql'));
  sql.authority = readCanonical(migrationPath('753_pharmacy_order_inventory_authority.sql'));
  sql.seeder = readCanonical(seederPath);
  sql.coveragePolicy = readCanonical(coveragePolicyPath);
  sql.schema = readCanonical(prismaSchemaPath);
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

  test('facility authority binds Cath catalog, usage, item, and batch identities exactly', () => {
    expect(sql.authority).toMatch(
      /ALTER TABLE cath_consumable_catalog[\s\S]*ADD COLUMN IF NOT EXISTS facility_id INTEGER/i,
    );
    expect(sql.authority).toMatch(
      /ALTER TABLE cath_case_consumable_usage[\s\S]*ADD COLUMN IF NOT EXISTS facility_id INTEGER[\s\S]*ADD COLUMN IF NOT EXISTS inventory_item_id INTEGER/i,
    );
    expect(sql.authority).toMatch(
      /FOREIGN KEY \(tenant_id, facility_id, inventory_item_id\)[\s\S]*REFERENCES pharmacy_inventory_items \(tenant_id, facility_id, id\)/i,
    );
    expect(sql.authority).toMatch(
      /FOREIGN KEY \(tenant_id, facility_id, catalog_item_id, inventory_item_id\)[\s\S]*REFERENCES cath_consumable_catalog \(tenant_id, facility_id, id, inventory_item_id\)/i,
    );
    expect(sql.authority).toMatch(
      /FOREIGN KEY \(tenant_id, facility_id, inventory_batch_id, inventory_item_id\)[\s\S]*REFERENCES pharmacy_inventory_batches \(tenant_id, facility_id, id, inventory_item_id\)/i,
    );
    expect(sql.authority).toMatch(
      /chk_cath_catalog_active_facility_mapping_753[\s\S]*status <> 'active'[\s\S]*facility_id IS NOT NULL[\s\S]*inventory_item_id IS NOT NULL[\s\S]*NOT VALID/i,
    );
    expect(sql.authority).toMatch(
      /chk_cath_usage_exact_inventory_authority_753[\s\S]*facility_id IS NOT NULL[\s\S]*inventory_item_id IS NOT NULL[\s\S]*inventory_batch_id IS NOT NULL[\s\S]*NOT VALID/i,
    );
    expect(sql.authority).toMatch(
      /cath_consumable_usage_inventory_status_check[\s\S]*'not_applicable'/i,
    );
  });

  test('pins each Cath case to its exact facility and keeps Prisma index parity', () => {
    expect(sql.authority).toMatch(
      /ALTER TABLE cath_lab_cases[\s\S]*ADD COLUMN IF NOT EXISTS facility_id INTEGER/i,
    );
    expect(sql.authority).toMatch(
      /UPDATE cath_lab_cases cath_case[\s\S]*encounter\.metadata->>'facility_id'/i,
    );
    expect(sql.authority).toMatch(
      /'CATH_CASE_FACILITY_UNRESOLVED'[\s\S]*'facility_status', facility\.status[\s\S]*'encounter_facility_id'/i,
    );
    expect(sql.authority).toMatch(
      /cath_case\.encounter_id IS NOT NULL[\s\S]*encounter\.id IS NULL[\s\S]*cath_case\.facility_id IS DISTINCT FROM[\s\S]*encounter\.metadata->>'facility_id'/i,
    );
    expect(sql.authority).toMatch(
      /FOREIGN KEY \(tenant_id, case_id, patient_uid, facility_id\)[\s\S]*REFERENCES cath_lab_cases \(tenant_id, id, patient_uid, facility_id\)/i,
    );
    expect(sql.authority).toMatch(
      /chk_cath_lab_case_facility_required_753[\s\S]*CHECK \(facility_id IS NOT NULL\) NOT VALID/i,
    );
    expect(sql.authority).toContain('ux_cath_lab_cases_usage_facility_753');
    expect(sql.schema).toMatch(
      /model cath_lab_cases \{[\s\S]*facility_id\s+Int\?[\s\S]*@@unique\(\[tenant_id, id, patient_uid, facility_id\], map: "ux_cath_lab_cases_usage_facility_753"\)/i,
    );
    expect(sql.authority).toContain('ux_pharmacy_batches_facility_item_id_cath_753');
    expect(sql.schema).toContain(
      '@@unique([tenant_id, facility_id, id, inventory_item_id], map: "ux_pharmacy_batches_facility_item_id_cath_753")',
    );
  });

  test('database guards make Cath facility, grant, event, task, and outbox identity immutable', () => {
    for (const trigger of [
      'trg_cath_case_authority_identity_753',
      'trg_cath_catalog_authority_identity_753',
      'trg_cath_usage_authority_identity_753',
      'trg_cath_task_authority_identity_753',
      'trg_cath_sla_authority_identity_753',
      'trg_cath_outbox_authority_identity_753',
      'trg_cath_movement_authority_identity_753',
      'trg_cath_usage_authority_contract_753',
    ]) {
      expect(sql.authority).toContain(trigger);
    }
    expect(sql.authority).toContain('cath_inventory_authority_assert_contract_753');
    for (const tag of [
      'cath_authority_identity_guard_753',
      'cath_authority_recovery_receipt_constraint_753',
      'cath_inventory_authority_assert_contract_753',
      'cath_inventory_authority_constraint_753',
      'cath_inventory_authority_runtime_privileges_753',
    ]) {
      expect(sql.authority).toContain(`END;\n$${tag}$;`);
    }
    expect(sql.authority).toContain('clinical_timeline_events timeline');
    expect(sql.authority).toContain('trg_cath_case_recovery_receipt_753');
    expect(sql.authority).toContain('trg_cath_catalog_recovery_receipt_753');
    expect(sql.authority).toContain(
      'Cath authority identity repair lacks its exact governed recovery receipt',
    );
    expect(sql.authority).toContain('clinical_audit_events audit');
    expect(sql.authority).toContain("recipient_facility_grant_id");
    expect(sql.authority).toContain("actor_facility_grant_id");
    expect(sql.authority).toContain("inventory_batch_id");
    expect(sql.authority).toContain('movement_total > usage_record.quantity');
    expect(sql.authority).toContain(
      'usage_record.inventory_movement_id IS DISTINCT FROM final_movement_id',
    );
    expect(sql.authority).toMatch(
      /inventory_decrement_status='not_applicable'[\s\S]*EXISTS \([\s\S]*FROM public\.pharmacy_stock_movements movement/i,
    );
    expect(sql.authority).toMatch(
      /inventory_decrement_status='not_applicable'[\s\S]*facility_id IS NULL[\s\S]*inventory_item_id IS NULL[\s\S]*inventory_batch_id IS NULL/i,
    );
    expect(sql.authority).toContain("app.pharmacy_recovery_command_key_sha256");
    expect(sql.authority).toMatch(
      /DEFERRABLE INITIALLY DEFERRED FOR EACH ROW[\s\S]*cath_inventory_authority_constraint_753/i,
    );
  });

  test('legacy Cath authority gaps are worklisted without default-facility inference', () => {
    expect(sql.authority).toContain("'cath_consumable_catalog'");
    expect(sql.authority).toContain("'cath_consumable_usage'");
    expect(sql.authority).toContain("'cath_lab_case'");
    expect(sql.authority).toContain("'CATH_CATALOG_FACILITY_UNRESOLVED'");
    expect(sql.authority).toContain("'CATH_USAGE_AUTHORITY_UNRESOLVED'");
    expect(sql.authority).toContain("'CATH_CASE_FACILITY_UNRESOLVED'");
    // 753 has grown past the Cath DDL: the insurance, MED03 supply and MED03
    // counter-sale authority blocks now sit between it and the pharmacy_orders
    // comment this slice used to stop at, so that end marker swept their text
    // into "the cath block" — counter-sale worklisting legitimately snapshots
    // candidate default facilities and tripped the no-default-inference guard
    // below. Stop at the next block header instead, and fail loudly if either
    // marker moves rather than silently slicing an empty or inverted range.
    const cathBlockStart = sql.authority.indexOf('-- Cath consumable custody is pinned');
    const cathBlockEnd = sql.authority.indexOf(
      '-- Exact insurance authority for pre-auth/claim creation.',
    );
    expect(cathBlockStart).toBeGreaterThan(-1);
    expect(cathBlockEnd).toBeGreaterThan(cathBlockStart);
    const cathBlock = sql.authority.slice(cathBlockStart, cathBlockEnd);
    expect(cathBlock).not.toMatch(/is_default\s*=\s*TRUE/i);
    expect(cathBlock).not.toMatch(
      /UPDATE cath_consumable_catalog[\s\S]*SET facility_id\s*=\s*item\.facility_id/i,
    );
    expect(cathBlock).not.toMatch(
      /UPDATE cath_case_consumable_usage[\s\S]*SET facility_id\s*=\s*catalog\.facility_id/i,
    );
    expect(cathBlock).not.toContain('exact_case_usage_facility');
    expect(cathBlock).toMatch(
      /LEFT JOIN pharmacy_inventory_batches batch[\s\S]*batch\.facility_id IS DISTINCT FROM usage\.facility_id[\s\S]*batch\.inventory_item_id IS DISTINCT FROM usage\.inventory_item_id/i,
    );
    expect(cathBlock).toContain("'case_facility_id', cath_case.facility_id");
    expect(cathBlock).toContain("'encounter_facility_id', CASE");
    expect(cathBlock).toMatch(
      /LEFT JOIN patient_encounters case_encounter[\s\S]*cath_case\.facility_id IS DISTINCT FROM[\s\S]*case_encounter\.metadata->>'facility_id'/i,
    );
    expect(cathBlock).toMatch(
      /batch\.batch_number IS DISTINCT FROM usage\.batch_number[\s\S]*batch\.lot_number IS DISTINCT FROM usage\.lot_number[\s\S]*batch\.expiry_date IS DISTINCT FROM usage\.expiry_date/i,
    );
    expect(cathBlock).toMatch(
      /inventory_decrement_status IN[\s\S]*NOT EXISTS \([\s\S]*FROM tasks task[\s\S]*NOT EXISTS \([\s\S]*FROM workflow_sla_instances sla[\s\S]*NOT EXISTS \([\s\S]*FROM notification_outbox outbox/i,
    );
    expect(cathBlock).toMatch(
      /EXISTS \([\s\S]*FROM pharmacy_stock_movements movement[\s\S]*actor_facility_grant_id[\s\S]*FROM pharmacy_staff_facility_grants movement_grant/i,
    );
    expect(cathBlock).toMatch(
      /NOT EXISTS \([\s\S]*FROM clinical_timeline_events timeline[\s\S]*NOT EXISTS \([\s\S]*FROM clinical_audit_events audit/i,
    );
    expect(cathBlock).toMatch(
      /delivery_coverage'[\s\S]*recipient_facility_grant_id[\s\S]*FROM pharmacy_staff_facility_grants recipient_grant/i,
    );
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

  // Migration 753 made a synthesized cath usage row impossible to seed
  // honestly: cath_inventory_authority_assert_contract_753 requires a
  // 'cath_inventory_shortfall_v1' owner task, a
  // 'cath_consumable_inventory_reconciliation' SLA and a
  // 'cath_inventory_shortfall' outbox entry whose recipient is backed by a real
  // pharmacy facility grant for every non-terminal usage row, so the generic
  // walker's pinned non-batch/non-implant snapshot no longer produces a legal
  // row. The table must still be ACCOUNTED for rather than quietly dropped from
  // coverage, so the contract moved to the governed intentionally-empty
  // registry the seeder derives its allow-list from — and the two sides must
  // not disagree.
  test('the comprehensive seeder accounts for cath usage and pins implant origins', () => {
    expect(sql.seeder).toContain(
      'const INTENTIONALLY_EMPTY_TABLES = new Set(INTENTIONALLY_EMPTY_SEED_TABLES);',
    );
    expect(sql.seeder).toContain(
      "import { INTENTIONALLY_EMPTY_SEED_TABLES } from '../src/db/seedCoveragePolicy.js';",
    );
    expect(sql.coveragePolicy).toMatch(
      /INTENTIONALLY_EMPTY_SEED_TABLES = Object\.freeze\(\[[\s\S]*'cath_case_consumable_usage',/,
    );
    expect(sql.coveragePolicy).toMatch(
      /cath_inventory_shortfall_v1[\s\S]*cath_consumable_inventory_reconciliation[\s\S]*'cath_case_consumable_usage',/,
    );
    // A table cannot be both intentionally empty and generically seeded.
    expect(sql.seeder).not.toMatch(/^\s*cath_case_consumable_usage:\s*\{/m);
    expect(sql.seeder).toMatch(/TABLE_COLUMN_SEED_OVERRIDES[\s\S]*surgical_implants/i);
    expect(sql.seeder).toMatch(/surgical_implants[\s\S]*cath_case_id:\s*null/i);
    expect(sql.seeder).toMatch(/surgical_implants[\s\S]*cath_usage_id:\s*null/i);
  });
});
