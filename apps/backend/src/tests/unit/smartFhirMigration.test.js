/**
 * Phase D3 — verifies migration 125 declares the three SMART-on-FHIR
 * OAuth tables with the constraints + indexes the service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/125_smart_on_fhir_oauth.sql',
);

describe('migration 125 — SMART-on-FHIR OAuth foundation', () => {
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
    ['smart_apps'], ['smart_authz_codes'], ['smart_access_tokens'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all 3 tables tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(3);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(3);
  });

  it('smart_apps allow-lists 3 app_kinds + 4 statuses', () => {
    expect(sql).toMatch(/CHECK \(app_kind IN \('public', 'confidential', 'backend_service'\)\)/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS smart_apps[\s\S]*CHECK \(status IN \('active', 'paused', 'revoked', 'archived'\)\)/i);
  });

  it('smart_apps unique on (tenant, client_id, environment)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS smart_apps[\s\S]*UNIQUE \(tenant_id, client_id, environment\)/i);
  });

  it('smart_authz_codes allow-lists PKCE methods (S256/plain) + 4 statuses', () => {
    expect(sql).toMatch(/pkce_method IS NULL OR pkce_method IN \('S256', 'plain'\)/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS smart_authz_codes[\s\S]*CHECK \(status IN \('pending', 'consumed', 'expired', 'revoked'\)\)/i);
  });

  it('smart_authz_codes unique on code_hash globally', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS smart_authz_codes[\s\S]*UNIQUE \(code_hash\)/i);
  });

  it('smart_authz_codes partial pending-expiry index', () => {
    expect(sql).toMatch(/idx_smart_authz_tenant_pending[\s\S]*WHERE status = 'pending'/i);
  });

  it('smart_access_tokens allow-lists 4 statuses incl. rotated', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS smart_access_tokens[\s\S]*CHECK \(status IN \('active', 'revoked', 'expired', 'rotated'\)\)/i);
  });

  it('smart_access_tokens has parent_token_id self-reference for rotation', () => {
    expect(sql).toMatch(/parent_token_id\s+INTEGER REFERENCES smart_access_tokens\(id\)/i);
  });

  it('smart_access_tokens unique access_token_hash globally', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS smart_access_tokens[\s\S]*UNIQUE \(access_token_hash\)/i);
  });

  it('smart_access_tokens partial active index for fast lookup', () => {
    expect(sql).toMatch(/idx_smart_tokens_tenant_active[\s\S]*WHERE status = 'active'/i);
  });

  it('environment allow-list (sandbox/production) on every table', () => {
    const envChecks = sql.match(/CHECK \(environment IN \('sandbox', 'production'\)\)/gi) || [];
    expect(envChecks.length).toBe(3);
  });
});
