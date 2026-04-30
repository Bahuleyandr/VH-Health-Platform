/**
 * Phase D1 — verifies migration 124 declares the eight ABDM HIP/HIU
 * tables with the constraints + indexes the service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/124_abdm_hip_hiu.sql',
);

describe('migration 124 — ABDM HIP/HIU foundation', () => {
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

  const TABLES = [
    'abha_profiles', 'abdm_facility_mappings', 'abdm_practitioner_mappings',
    'abdm_care_contexts', 'abdm_consent_requests', 'abdm_consent_artifacts',
    'abdm_data_transfers', 'abdm_webhook_events',
  ];

  it.each(TABLES.map((t) => [t]))('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all 8 tables tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(8);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(8);
  });

  it('abha_profiles unique on (tenant, abha_id) AND (tenant, patient_uid)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS abha_profiles[\s\S]*UNIQUE \(tenant_id, abha_id\)[\s\S]*UNIQUE \(tenant_id, patient_uid\)/i);
  });

  it('care_contexts allow-lists 7 hi_type values', () => {
    const types = ['OPConsultation', 'DischargeSummary', 'Prescription',
      'DiagnosticReport', 'ImmunizationRecord', 'WellnessRecord', 'HealthDocumentRecord'];
    for (const t of types) expect(sql).toMatch(new RegExp(`'${t}'`));
  });

  it('consent_requests allow-list 7 purpose codes + 6 statuses', () => {
    const purposes = ['CAREMGT', 'BTG', 'PUBHTH', 'HPAYMT', 'DSRCH', 'PATRQT', 'OTHER'];
    for (const p of purposes) expect(sql).toMatch(new RegExp(`'${p}'`));
    expect(sql).toMatch(/CHECK \(status IN \('requested', 'granted', 'denied', 'revoked', 'expired', 'failed'\)\)/i);
  });

  it('consent_requests environment-scoped uniqueness', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS abdm_consent_requests[\s\S]*UNIQUE \(tenant_id, request_id, environment\)/i);
  });

  it('consent_artifacts active-with-expiry partial index', () => {
    expect(sql).toMatch(/idx_consent_artifacts_active_expiry[\s\S]*WHERE status = 'active' AND expiry_at IS NOT NULL/i);
  });

  it('data_transfers allow-lists 5 statuses + 5 encryption kinds', () => {
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'in_flight', 'succeeded', 'failed', 'partial'\)\)/i);
    const kinds = ['ecdh_aes_256_gcm', 'ecdh_aes_128_gcm', 'rsa_oaep', 'manual', 'other'];
    for (const k of kinds) expect(sql).toMatch(new RegExp(`'${k}'`));
  });

  it('webhook_events unique on (tenant, external_event_id, environment) for idempotency', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS abdm_webhook_events[\s\S]*UNIQUE \(tenant_id, external_event_id, environment\)/i);
  });

  it('webhook_events allow-lists 5 statuses', () => {
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'processed', 'duplicate', 'failed', 'rejected'\)\)/i);
  });

  it('all 4 transactional tables environment allow-list (sandbox/production)', () => {
    const envChecks = sql.match(/CHECK \(environment IN \('sandbox', 'production'\)\)/gi) || [];
    expect(envChecks.length).toBeGreaterThanOrEqual(4);
  });
});
