/**
 * Phase C4 — verifies migration 123 declares the ten pharmacy supply
 * chain tables with the constraints + indexes the service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/123_pharmacy_supply_chain.sql',
);

describe('migration 123 — pharmacy supply chain', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(3000);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  const TABLES = [
    'pharmacy_suppliers', 'pharmacy_inventory_items', 'pharmacy_inventory_batches',
    'pharmacy_purchase_orders', 'pharmacy_purchase_order_items',
    'pharmacy_goods_receipts', 'pharmacy_goods_receipt_items',
    'pharmacy_stock_movements', 'pharmacy_expiry_alerts', 'pharmacy_substitutes',
  ];

  it.each(TABLES.map((t) => [t]))('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all 10 tables tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(10);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(10);
  });

  it('pharmacy_inventory_batches enforces remaining<=received via CHECK', () => {
    expect(sql).toMatch(/chk_batch_remaining CHECK \(remaining_quantity >= 0 AND remaining_quantity <= received_quantity\)/i);
  });

  it('pharmacy_inventory_batches allow-lists 7 statuses', () => {
    const statuses = ['in_stock', 'reserved', 'depleted', 'expired', 'recalled', 'quarantined', 'disposed'];
    for (const s of statuses) expect(sql).toMatch(new RegExp(`'${s}'`));
  });

  it('pharmacy_inventory_batches partial expiry index covers in_stock + reserved', () => {
    expect(sql).toMatch(/idx_pharmacy_batches_tenant_expiry[\s\S]*WHERE status IN \('in_stock', 'reserved'\)/i);
  });

  it('pharmacy_inventory_batches unique on (item, batch_number)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS pharmacy_inventory_batches[\s\S]*UNIQUE \(inventory_item_id, batch_number\)/i);
  });

  it('pharmacy_purchase_orders allow-lists 7 statuses', () => {
    const statuses = ['draft', 'submitted', 'approved', 'partially_received', 'fully_received', 'cancelled', 'closed'];
    for (const s of statuses) expect(sql).toMatch(new RegExp(`'${s}'`));
  });

  it('pharmacy_purchase_order_items enforces received<=ordered CHECK', () => {
    expect(sql).toMatch(/chk_po_received_lte_ordered CHECK \(received_quantity <= ordered_quantity\)/i);
  });

  it('pharmacy_stock_movements allow-lists 10 movement_kinds', () => {
    const kinds = ['receive', 'issue', 'transfer_out', 'transfer_in', 'return',
      'adjust_increase', 'adjust_decrease', 'dispose', 'expire', 'recall'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
  });

  it('pharmacy_expiry_alerts allow-lists 4 severities + 6 statuses', () => {
    expect(sql).toMatch(/CHECK \(severity IN \('low', 'medium', 'high', 'critical'\)\)/i);
    const statuses = ['open', 'acknowledged', 'returned', 'disposed', 'expired_used', 'cancelled'];
    for (const s of statuses) expect(sql).toMatch(new RegExp(`'${s}'`));
  });

  it('pharmacy_substitutes prevents self-substitution via CHECK + unique pair', () => {
    expect(sql).toMatch(/chk_substitute_distinct CHECK \(primary_item_id <> substitute_item_id\)/i);
    expect(sql).toMatch(/UNIQUE \(tenant_id, primary_item_id, substitute_item_id\)/i);
  });

  it('declares hot-path indexes', () => {
    const expected = [
      /idx_pharmacy_suppliers_tenant_status/i,
      /idx_pharmacy_items_tenant_status/i,
      /idx_pharmacy_items_narcotic[\s\S]*WHERE is_narcotic = true/i,
      /idx_pharmacy_batches_item_status/i,
      /idx_pharmacy_batches_tenant_expiry/i,
      /idx_pharmacy_po_tenant_status/i,
      /idx_pharmacy_grn_tenant_status/i,
      /idx_pharmacy_mvmt_item_time/i,
      /idx_expiry_alerts_severity[\s\S]*WHERE status = 'open'/i,
    ];
    for (const re of expected) expect(sql).toMatch(re);
  });
});
