/**
 * Phase A3 PR1 — verifies migration 115 declares the six foundation
 * tables for the integration + webhook registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/115_integration_webhook_registry.sql',
);

describe('migration 115 — integration + webhook registry', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(1500);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it.each([
    ['integrations'],
    ['integration_credentials'],
    ['webhook_subscriptions'],
    ['webhook_deliveries'],
    ['external_system_mappings'],
    ['integration_logs'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i');
    expect(sql).toMatch(re);
  });

  it('every table is tenant-scoped via tenant_id REFERENCES tenants(id)', () => {
    const tableMatches = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tableMatches.length).toBe(6);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(6);
  });

  it('integrations enforces (tenant_id, name) uniqueness + status allow-list', () => {
    expect(sql).toMatch(/UNIQUE \(tenant_id, name\)/i);
    expect(sql).toMatch(/CHECK \(status IN \('active', 'paused', 'failed', 'archived'\)\)/i);
  });

  it('integration_credentials enforces (integration_id, credential_key) uniqueness', () => {
    expect(sql).toMatch(/UNIQUE \(integration_id, credential_key\)/i);
  });

  it('webhook_subscriptions allow-lists signing_algorithm + enforces composite uniqueness', () => {
    expect(sql).toMatch(/CHECK \(signing_algorithm IN \('hmac-sha256', 'hmac-sha512', 'none'\)\)/i);
    expect(sql).toMatch(/UNIQUE \(integration_id, event_type, endpoint_url\)/i);
  });

  it('webhook_subscriptions has a partial index on active subscriptions', () => {
    expect(sql).toMatch(/idx_webhook_subs_tenant_event[\s\S]*WHERE is_active = true/i);
  });

  it('webhook_deliveries allow-lists status', () => {
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'in_flight', 'succeeded', 'failed', 'dead'\)\)/i);
  });

  it('external_system_mappings enforces (tenant, integration, type, internal_id) uniqueness', () => {
    expect(sql).toMatch(/UNIQUE \(tenant_id, integration_id, internal_resource_type, internal_id\)/i);
  });

  it('integration_logs allow-lists log_type and severity', () => {
    const logTypeBlock = sql.match(/CHECK \(log_type IN \([\s\S]*?\)\)/i);
    expect(logTypeBlock).toBeTruthy();
    for (const value of [
      'config_change', 'auth_refresh', 'webhook_send', 'webhook_receive',
      'mapping_sync', 'health_check', 'error',
    ]) {
      expect(logTypeBlock[0]).toContain(`'${value}'`);
    }
    expect(sql).toMatch(/severity IN \('debug', 'info', 'warn', 'error'\)/i);
  });

  it('declares the hot-path indexes for each table', () => {
    const expected = [
      /idx_integrations_tenant_status/i,
      /idx_integrations_tenant_type/i,
      /idx_integration_credentials_tenant/i,
      /idx_webhook_subs_integration/i,
      /idx_webhook_deliveries_tenant_status/i,
      /idx_webhook_deliveries_subscription_time/i,
      /idx_external_mappings_external/i,
      /idx_external_mappings_internal/i,
      /idx_integration_logs_tenant_time/i,
      /idx_integration_logs_severity_time/i,
    ];
    for (const re of expected) expect(sql).toMatch(re);
  });
});
