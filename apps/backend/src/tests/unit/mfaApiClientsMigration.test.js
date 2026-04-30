/**
 * Phase B4 — verifies migration 120 declares the five MFA + API client
 * tables (mfa_devices / mfa_backup_codes / mfa_challenges / api_clients
 * / api_keys) with the constraints + indexes the services rely on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/120_mfa_api_clients.sql',
);

describe('migration 120 — MFA + API clients', () => {
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
    ['mfa_devices'], ['mfa_backup_codes'], ['mfa_challenges'],
    ['api_clients'], ['api_keys'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('all 5 tables tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(5);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(5);
  });

  it('mfa_devices allow-lists 4 device_kinds and 3 statuses', () => {
    expect(sql).toMatch(/CHECK \(device_kind IN \('totp', 'webauthn', 'sms', 'email'\)\)/i);
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'verified', 'revoked'\)\)/i);
  });

  it('mfa_devices allow-lists 3 algorithms + digit/period values', () => {
    expect(sql).toMatch(/CHECK \(algorithm IN \('sha1', 'sha256', 'sha512'\)\)/i);
    expect(sql).toMatch(/digits\s+INTEGER NOT NULL DEFAULT 6 CHECK \(digits IN \(6, 8\)\)/i);
    expect(sql).toMatch(/period_seconds\s+INTEGER NOT NULL DEFAULT 30 CHECK \(period_seconds IN \(30, 60\)\)/i);
  });

  it('mfa_devices enforces single verified TOTP device per user via partial unique index', () => {
    expect(sql).toMatch(/uq_mfa_user_verified_totp[\s\S]*WHERE device_kind = 'totp' AND status = 'verified'/i);
  });

  it('mfa_challenges enforces (device, step) replay-prevention via partial unique index', () => {
    expect(sql).toMatch(/uq_mfa_challenges_step_unique[\s\S]*\(mfa_device_id, step\)[\s\S]*WHERE step IS NOT NULL AND status = 'success'/i);
  });

  it('mfa_backup_codes index on unused codes', () => {
    expect(sql).toMatch(/idx_mfa_backup_codes_user[\s\S]*WHERE used_at IS NULL/i);
  });

  it('api_clients allow-lists 6 client_kind + 4 statuses', () => {
    expect(sql).toMatch(/CHECK \(client_kind IN \('integration', 'webhook', 'mobile_app', 'partner', 'internal_service', 'other'\)\)/i);
    expect(sql).toMatch(/CHECK \(status IN \('active', 'paused', 'revoked', 'archived'\)\)/i);
  });

  it('api_clients unique on (tenant_id, client_code)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS api_clients[\s\S]*UNIQUE \(tenant_id, client_code\)/i);
  });

  it('api_keys store key_hash globally unique (UNIQUE constraint)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS api_keys[\s\S]*UNIQUE \(key_hash\)/i);
  });

  it('api_keys allow-lists 3 statuses', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS api_keys[\s\S]*CHECK \(status IN \('active', 'revoked', 'expired'\)\)/i);
  });
});
