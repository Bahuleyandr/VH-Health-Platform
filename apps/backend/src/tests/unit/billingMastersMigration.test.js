/**
 * Phase B3 — verifies migration 119 declares the seven payer / TPA /
 * tariff / package master tables with the constraints + indexes the
 * service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/119_payer_tpa_masters.sql',
);

describe('migration 119 — payer / TPA / tariff / package masters', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(2000);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it.each([
    ['payers'], ['tpas'], ['tariff_plans'], ['tariff_items'],
    ['packages'], ['package_items'], ['payer_tariff_links'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all 7 tables tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(7);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(7);
  });

  it('payers allow-lists 7 payer_kind values', () => {
    const kinds = ['private_insurance', 'government_scheme', 'corporate', 'self_pay',
      'international_insurance', 'cash_advance', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
  });

  it('payers unique on (tenant, payer_code)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS payers[\s\S]*UNIQUE \(tenant_id, payer_code\)/i);
  });

  it('tpas optionally link to a parent payer', () => {
    expect(sql).toMatch(/parent_payer_id\s+INTEGER REFERENCES payers\(id\)/i);
  });

  it('tariff_plans enforce single default per tenant via partial unique index', () => {
    expect(sql).toMatch(/uq_tariff_plan_default[\s\S]*WHERE is_default = true AND status = 'active'/i);
  });

  it('tariff_plans + tariff_items + payer_tariff_links enforce window CHECK', () => {
    expect(sql).toMatch(/chk_tariff_window CHECK \(effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from\)/i);
    expect(sql).toMatch(/chk_tariff_item_window CHECK/i);
    expect(sql).toMatch(/chk_payer_tariff_window CHECK/i);
  });

  it('tariff_items unique per (tariff_plan_id, service_code)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS tariff_items[\s\S]*UNIQUE \(tariff_plan_id, service_code\)/i);
  });

  it('tariff_items allow-lists 10 service_kind values', () => {
    const kinds = ['service', 'consultation', 'procedure', 'investigation', 'medication',
      'consumable', 'room', 'package', 'discount', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
  });

  it('payer_tariff_links require either payer_id or tpa_id (CHECK)', () => {
    expect(sql).toMatch(/chk_payer_tariff_subject CHECK \([\s\S]*payer_id IS NOT NULL[\s\S]*OR[\s\S]*tpa_id IS NOT NULL/i);
  });

  it('packages allow-lists 4 statuses', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS packages[\s\S]*CHECK \(status IN \('draft', 'active', 'paused', 'archived'\)\)/i);
  });
});
