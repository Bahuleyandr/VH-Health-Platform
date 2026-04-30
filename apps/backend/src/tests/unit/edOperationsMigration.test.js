/**
 * Phase D4 — verifies migration 126 declares the four ED operational
 * tables with the constraints + indexes the service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/126_ed_operational_entities.sql',
);

describe('migration 126 — ED operational entities', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(2500);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it.each([
    ['emergency_visits'], ['triage_assessments'], ['ambulance_requests'], ['mlc_records'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all 4 tables tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(4);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(4);
  });

  it('emergency_visits allow-lists 7 arrival_modes + 12 statuses', () => {
    const modes = ['walk_in', 'ambulance', 'air_ambulance', 'self_transport',
      'transfer_in', 'police', 'other'];
    for (const m of modes) expect(sql).toMatch(new RegExp(`'${m}'`));
    const statuses = ['arriving', 'in_triage', 'awaiting_treatment', 'in_treatment',
      'awaiting_disposition', 'admitted', 'discharged', 'transferred',
      'left_against_advice', 'lwbs', 'expired', 'archived'];
    for (const s of statuses) expect(sql).toMatch(new RegExp(`'${s}'`));
  });

  it('emergency_visits allow-lists triage_priority across ESI/Manchester/CTAS', () => {
    const priorities = [
      'esi_1', 'esi_5',
      'manchester_red', 'manchester_blue',
      'ctas_1', 'ctas_5', 'unassigned',
    ];
    for (const p of priorities) expect(sql).toMatch(new RegExp(`'${p}'`));
  });

  it('emergency_visits partial open + MLC indexes', () => {
    expect(sql).toMatch(/idx_ed_visits_open[\s\S]*WHERE status NOT IN/i);
    expect(sql).toMatch(/idx_ed_visits_mlc[\s\S]*WHERE is_mlc = true/i);
  });

  it('triage_assessments allow-lists 6 assessment_kinds + pain_score range', () => {
    expect(sql).toMatch(/CHECK \(assessment_kind IN \('esi', 'manchester', 'ctas', 'pat', 'australian', 'other'\)\)/i);
    expect(sql).toMatch(/pain_score\s+INTEGER\s+CHECK \(pain_score IS NULL OR \(pain_score >= 0 AND pain_score <= 10\)\)/i);
  });

  it('ambulance_requests allow-lists 9 statuses + 4 priorities + 6 kinds', () => {
    const statuses = ['requested', 'dispatched', 'en_route', 'on_scene',
      'returning', 'arrived', 'cancelled', 'completed', 'failed'];
    for (const s of statuses) expect(sql).toMatch(new RegExp(`'${s}'`));
    expect(sql).toMatch(/CHECK \(priority IN \('low', 'medium', 'high', 'critical'\)\)/i);
    const kinds = ['pickup', 'transfer_out', 'inter_facility', 'home_to_hospital', 'air_evac', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
  });

  it('ambulance_requests partial open-priority index', () => {
    expect(sql).toMatch(/idx_ambulance_priority_open[\s\S]*WHERE status IN \('requested', 'dispatched', 'en_route', 'on_scene'\)/i);
  });

  it('mlc_records allow-lists 17 mlc_kinds + 5 statuses', () => {
    const kinds = ['rta', 'assault', 'sexual_assault', 'poisoning', 'self_harm',
      'attempted_suicide', 'burn', 'electric_shock', 'drowning', 'animal_bite',
      'snake_bite', 'industrial_accident', 'firearm_injury', 'sharp_weapon_injury',
      'unknown_unconscious', 'pregnancy_related', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
    expect(sql).toMatch(/CHECK \(status IN \('open', 'pending_certification', 'certified', 'closed', 'cancelled'\)\)/i);
  });

  it('mlc_records partial unreported index for police-reporting backlog', () => {
    expect(sql).toMatch(/idx_mlc_unreported[\s\S]*WHERE reported_to_police_at IS NULL AND status NOT IN \('cancelled', 'closed'\)/i);
  });

  it('all entities have unique numbering', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS emergency_visits[\s\S]*UNIQUE \(tenant_id, visit_number\)/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS ambulance_requests[\s\S]*UNIQUE \(tenant_id, request_number\)/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS mlc_records[\s\S]*UNIQUE \(tenant_id, mlc_number\)/i);
  });
});
