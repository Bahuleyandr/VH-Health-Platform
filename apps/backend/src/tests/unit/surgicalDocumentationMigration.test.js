/**
 * Tier B PR1 — verifies migration 116 declares the seven surgical /
 * OR clinical entities (preop_checklists, intraop_notes, postop_notes,
 * anesthesia_records, surgical_implants, surgical_safety_checklists,
 * postop_complication_alerts) with the constraints + indexes the
 * surgicalDocumentationService relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/116_surgical_clinical_entities.sql',
);

describe('migration 116 — surgical / OR clinical entities', () => {
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
    ['preop_checklists'],
    ['intraop_notes'],
    ['postop_notes'],
    ['anesthesia_records'],
    ['surgical_implants'],
    ['surgical_safety_checklists'],
    ['postop_complication_alerts'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
    expect(sql).toMatch(re);
  });

  it('every table is tenant-scoped via a tenant_id UUID column', () => {
    const tableMatches = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tableMatches.length).toBe(7);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(7);
  });

  it('every table FKs to ot_schedules', () => {
    const fks = sql.match(/ot_schedule_id\s+INTEGER NOT NULL REFERENCES ot_schedules\(id\)/gi) || [];
    expect(fks.length).toBe(7);
  });

  it('preop_checklists is unique per (tenant, ot_schedule)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS preop_checklists[\s\S]*UNIQUE \(tenant_id, ot_schedule_id\)/i);
  });

  it('preop_checklists allow-lists status', () => {
    expect(sql).toMatch(/CHECK \(status IN \('in_progress', 'complete', 'incomplete_with_override'\)\)/i);
  });

  it('intraop_notes allow-lists status (draft/finalized/amended)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS intraop_notes[\s\S]*CHECK \(status IN \('draft', 'finalized', 'amended'\)\)/i);
  });

  it('intraop_notes carries surgical-counts triple booleans', () => {
    expect(sql).toMatch(/sponge_count_correct\s+BOOLEAN/i);
    expect(sql).toMatch(/sharp_count_correct\s+BOOLEAN/i);
    expect(sql).toMatch(/instrument_count_correct\s+BOOLEAN/i);
  });

  it('postop_notes allow-lists recovery_phase to 7 values', () => {
    const phases = ['pacu', 'phase1', 'phase2', 'ward', 'hdu', 'icu', 'discharged'];
    for (const p of phases) {
      expect(sql).toMatch(new RegExp(`'${p}'`));
    }
    expect(sql).toMatch(/CHECK \(recovery_phase IS NULL OR recovery_phase IN/i);
  });

  it('postop_notes constrains pain_score to 0..10', () => {
    expect(sql).toMatch(/pain_score\s+INTEGER\s+CHECK \(pain_score IS NULL OR \(pain_score >= 0 AND pain_score <= 10\)\)/i);
  });

  it('anesthesia_records allow-lists ASA grades I..VI plus E suffix variants', () => {
    expect(sql).toMatch(/asa_grade IS NULL OR asa_grade IN \('I', 'II', 'III', 'IV', 'V', 'VI', 'IE', 'IIE', 'IIIE', 'IVE', 'VE'\)/);
  });

  it('anesthesia_records allow-lists technique to 7 values', () => {
    expect(sql).toMatch(/'general', 'regional_spinal', 'regional_epidural', 'regional_block',\s+'mac', 'local', 'combined'/);
  });

  it('anesthesia_records is unique per (tenant, ot_schedule)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS anesthesia_records[\s\S]*UNIQUE \(tenant_id, ot_schedule_id\)/i);
  });

  it('surgical_implants allow-lists status (planned/in_situ/removed/replaced/recalled)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS surgical_implants[\s\S]*CHECK \(status IN \('planned', 'in_situ', 'removed', 'replaced', 'recalled'\)\)/i);
  });

  it('surgical_implants indexes UDI lookups', () => {
    expect(sql).toMatch(/idx_surgical_implants_udi[\s\S]*WHERE udi IS NOT NULL/i);
  });

  it('surgical_implants indexes manufacturer + lot_number for recall sweeps', () => {
    expect(sql).toMatch(/idx_surgical_implants_lot[\s\S]*\(tenant_id, manufacturer, lot_number\)/i);
  });

  it('surgical_safety_checklists declares the WHO three phases as allow-list', () => {
    expect(sql).toMatch(/phase\s+VARCHAR\(20\) NOT NULL[\s\S]*CHECK \(phase IN \('sign_in', 'time_out', 'sign_out'\)\)/i);
  });

  it('surgical_safety_checklists is unique per (tenant, ot_schedule, phase)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS surgical_safety_checklists[\s\S]*UNIQUE \(tenant_id, ot_schedule_id, phase\)/i);
  });

  it('postop_complication_alerts allow-lists complication_type to 16 values', () => {
    const types = [
      'anastomotic_leak', 'deep_ssi', 'superficial_ssi', 'wound_dehiscence',
      'return_to_theatre', 'reintubation', 'dvt', 'pe', 'mi', 'cva',
      'aki', 'sepsis', 'hemorrhage', 'ileus', 'organ_injury', 'other',
    ];
    for (const t of types) {
      expect(sql).toMatch(new RegExp(`'${t}'`));
    }
  });

  it('postop_complication_alerts allow-lists Clavien-Dindo grades', () => {
    expect(sql).toMatch(/clavien_dindo_grade IS NULL OR clavien_dindo_grade IN \('I', 'II', 'IIIa', 'IIIb', 'IVa', 'IVb', 'V'\)/);
  });

  it('postop_complication_alerts allow-lists status (open/acknowledged/resolved/false_positive)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS postop_complication_alerts[\s\S]*CHECK \(status IN \('open', 'acknowledged', 'resolved', 'false_positive'\)\)/i);
  });

  it('declares hot-path indexes for tenant-scoped queries', () => {
    const expected = [
      /idx_preop_checklists_tenant_status/i,
      /idx_preop_checklists_schedule/i,
      /idx_intraop_notes_tenant_schedule/i,
      /idx_intraop_notes_status/i,
      /idx_postop_notes_tenant_schedule/i,
      /idx_postop_notes_phase/i,
      /idx_anesthesia_records_tenant_status/i,
      /idx_anesthesia_records_asa/i,
      /idx_surgical_implants_tenant_patient/i,
      /idx_surgical_implants_schedule/i,
      /idx_safety_checklists_schedule/i,
      /idx_safety_checklists_tenant_status/i,
      /idx_postop_complications_schedule/i,
      /idx_postop_complications_tenant_status/i,
      /idx_postop_complications_patient/i,
    ];
    for (const re of expected) {
      expect(sql).toMatch(re);
    }
  });
});
