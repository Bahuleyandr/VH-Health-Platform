import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(here, '../../migrations/753_pharmacy_order_inventory_authority.sql'),
  'utf8',
);

describe('migration 753 pharmacy supply runtime authority', () => {
  it('pins sensitive supplier records to one facility and worklists ambiguous legacy rows', () => {
    expect(migration).toMatch(/ALTER TABLE pharmacy_suppliers[\s\S]*ADD COLUMN IF NOT EXISTS facility_id INTEGER/);
    expect(migration).toMatch(/SUPPLIER_FACILITY_AUTHORITY_UNRESOLVED/);
    expect(migration).toMatch(/fk_pharmacy_suppliers_facility_authority_supply_753/);
    expect(migration).toMatch(/trg_pharmacy_supplier_rehome_supply_753/);
  });

  it('pins every usable batch to one exact facility storage location', () => {
    expect(migration).toMatch(/ux_facility_locations_tenant_facility_id_supply_753/);
    expect(migration).toMatch(/fk_pharmacy_batches_storage_authority_supply_753[\s\S]*FOREIGN KEY \(tenant_id, facility_id, storage_location_id\)/);
    expect(migration).toMatch(/BATCH_STORAGE_LOCATION_AUTHORITY_INVALID/);
    expect(migration).toMatch(/trg_pharmacy_batch_storage_authority_supply_753/);
    expect(migration).toMatch(/trg_pharmacy_storage_location_rehome_supply_753/);
  });

  it('makes supply command receipts and historical item authority immutable', () => {
    expect(migration).toMatch(/trg_pharmacy_supply_receipt_immutable_753/);
    expect(migration).toMatch(/pharmacy_inventory_direct_receive_v1/);
    expect(migration).toMatch(/pharmacy_grn_receive_line_v1/);
    expect(migration).toMatch(/pharmacy_supply_stock_movement_v1/);
    expect(migration).toMatch(/trg_pharmacy_inventory_item_rehome_supply_753/);
    expect(migration).toMatch(/INVENTORY_ITEM_AUTHORITY_REHOME/);
  });

  it('enforces one-way GRN and line-QC terminal states in the database', () => {
    expect(migration).toMatch(/chk_pharmacy_goods_receipts_status_supply_753/);
    expect(migration).toMatch(/trg_pharmacy_grn_lifecycle_supply_753/);
    expect(migration).toMatch(/trg_pharmacy_grn_item_qc_immutable_supply_753/);
    expect(migration).toMatch(/'closed', 'rejected', 'archived'/);
  });
});
