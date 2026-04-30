/**
 * Phase A2 PR1 — verifies migration 114 declares the foundation tables
 * patient_identifiers / patient_duplicate_candidates / patient_merge_requests
 * with the constraints + indexes the service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/114_patient_identifiers_dedupe.sql',
);

describe('migration 114 — patient identifiers + dedupe foundation', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(800);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it.each([
    ['patient_identifiers'],
    ['patient_duplicate_candidates'],
    ['patient_merge_requests'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
    expect(sql).toMatch(re);
  });

  it('every table is tenant-scoped via a tenant_id UUID column', () => {
    const tableMatches = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tableMatches.length).toBe(3);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(3);
  });

  it('patient_identifiers enforces the 14-value identifier_type allow-list', () => {
    const expected = [
      'mrn', 'uhid', 'abha', 'abha_address', 'mobile', 'aadhaar_token',
      'passport', 'insurance', 'tpa_card', 'employee_id', 'external_emr',
      'national_id', 'driving_license', 'other',
    ];
    for (const value of expected) {
      expect(sql).toMatch(new RegExp(`'${value}'`));
    }
    expect(sql).toMatch(/CHECK \(identifier_type IN \(/i);
  });

  it('patient_identifiers enforces partial unique among ACTIVE rows only', () => {
    expect(sql).toMatch(/UNIQUE INDEX IF NOT EXISTS uq_patient_identifiers_active_value[\s\S]*WHERE status = 'active'/i);
  });

  it('patient_identifiers indexes hash lookups when the column is populated', () => {
    expect(sql).toMatch(/idx_patient_identifiers_tenant_type_hash[\s\S]*WHERE identifier_value_hash IS NOT NULL/i);
  });

  it('patient_duplicate_candidates blocks self-pair via CHECK + uniqueness across (tenant, primary, secondary)', () => {
    expect(sql).toMatch(/CONSTRAINT chk_dup_distinct CHECK \(primary_uid <> secondary_uid\)/i);
    expect(sql).toMatch(/uq_patient_dup_pair[\s\S]*\(tenant_id, primary_uid, secondary_uid\)/i);
  });

  it('patient_duplicate_candidates allow-lists detected_by + status', () => {
    expect(sql).toMatch(/detected_by IN \('rule_engine', 'admin_manual', 'identifier_collision', 'name_phonetic', 'imported'\)/i);
    expect(sql).toMatch(/CHECK \(status IN \('open', 'merged', 'rejected_not_duplicate', 'expired'\)\)/i);
  });

  it('patient_merge_requests blocks self-merge and gates approval on status progression', () => {
    expect(sql).toMatch(/CONSTRAINT chk_merge_distinct CHECK \(primary_uid <> secondary_uid\)/i);
    expect(sql).toMatch(/CONSTRAINT chk_merge_status_progress CHECK/i);
  });

  it('patient_merge_requests allow-lists status', () => {
    expect(sql).toMatch(/CHECK \(status IN \('requested', 'approved', 'executed', 'rejected', 'cancelled'\)\)/i);
  });

  it('declares hot-path indexes for tenant-scoped queries', () => {
    const expected = [
      /idx_patient_identifiers_tenant_patient/i,
      /idx_patient_identifiers_merged_into/i,
      /idx_patient_dup_tenant_status/i,
      /idx_patient_dup_run/i,
      /idx_patient_merge_tenant_status/i,
      /idx_patient_merge_primary/i,
      /idx_patient_merge_secondary/i,
    ];
    for (const re of expected) {
      expect(sql).toMatch(re);
    }
  });
});
