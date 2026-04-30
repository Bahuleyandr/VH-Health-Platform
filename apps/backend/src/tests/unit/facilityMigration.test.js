/**
 * Phase C1 — verifies migration 121 declares the four facility / location
 * / room / service-catalog tables with the constraints + indexes the
 * service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/121_facility_location_room.sql',
);

describe('migration 121 — facility / location / room / service catalog', () => {
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
    ['facilities'], ['facility_locations'], ['facility_rooms'], ['service_catalog'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all 4 tables tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(4);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(4);
  });

  it('facilities allow-lists 8 facility_kinds + 3 statuses', () => {
    const kinds = ['hospital', 'clinic', 'diagnostic_center', 'pharmacy',
      'tele_hub', 'corporate_office', 'satellite_unit', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS facilities[\s\S]*CHECK \(status IN \('active', 'paused', 'archived'\)\)/i);
  });

  it('facilities unique on (tenant_id, facility_code) + single-default partial unique', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS facilities[\s\S]*UNIQUE \(tenant_id, facility_code\)/i);
    expect(sql).toMatch(/uq_facility_default[\s\S]*WHERE is_default = true/i);
  });

  it('facility_locations allow-lists 19 location_kind values + has self-parent CHECK', () => {
    expect(sql).toMatch(/'opd', 'ipd', 'icu', 'hdu', 'er', 'ot_block'/);
    expect(sql).toMatch(/chk_location_no_self_parent CHECK \(parent_id IS NULL OR parent_id <> id\)/i);
  });

  it('facility_locations unique on (facility_id, location_code)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS facility_locations[\s\S]*UNIQUE \(facility_id, location_code\)/i);
  });

  it('facility_rooms allow-lists 13 room_kind + 4 statuses', () => {
    const roomKinds = ['general', 'private', 'semi_private', 'shared',
      'icu', 'isolation', 'ot', 'consulting', 'examination',
      'procedure', 'recovery', 'storage', 'other'];
    for (const k of roomKinds) expect(sql).toMatch(new RegExp(`'${k}'`));
    expect(sql).toMatch(/CHECK \(status IN \('active', 'closed_for_cleaning', 'maintenance', 'archived'\)\)/i);
  });

  it('facility_rooms unique on (facility_id, room_code)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS facility_rooms[\s\S]*UNIQUE \(facility_id, room_code\)/i);
  });

  it('service_catalog allow-lists 12 service_kind + 4 statuses', () => {
    const kinds = ['consultation', 'procedure', 'investigation', 'imaging',
      'pharmacy_dispense', 'package', 'room', 'admission',
      'home_visit', 'teleconsult', 'service', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
  });

  it('declares hot-path indexes', () => {
    const expected = [
      /idx_facilities_tenant_status/i,
      /idx_facilities_tenant_kind/i,
      /idx_facility_locations_tenant_facility/i,
      /idx_facility_locations_kind/i,
      /idx_facility_locations_parent/i,
      /idx_facility_rooms_tenant_facility/i,
      /idx_facility_rooms_location/i,
      /idx_service_catalog_tenant_status/i,
    ];
    for (const re of expected) expect(sql).toMatch(re);
  });
});
