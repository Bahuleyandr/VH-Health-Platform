import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_427_PATH = path.resolve(
  __dirname,
  '../../migrations/427_api_clients_developer_portal_profile.sql',
);
const MIGRATION_428_PATH = path.resolve(
  __dirname,
  '../../migrations/428_developer_portal_audit_events.sql',
);

describe('migrations 427-428 — developer portal P1', () => {
  let migration427;
  let migration428;

  beforeAll(() => {
    migration427 = fs.readFileSync(MIGRATION_427_PATH, 'utf8');
    migration428 = fs.readFileSync(MIGRATION_428_PATH, 'utf8');
  });

  it('adds sandbox/production environment classification to api_clients', () => {
    expect(migration427).toMatch(/ALTER TABLE api_clients[\s\S]*ADD COLUMN IF NOT EXISTS environment/i);
    expect(migration427).toMatch(/CHECK \(environment IN \('sandbox', 'production'\)\)/i);
    expect(migration427).toMatch(/idx_api_clients_environment_status/i);
  });

  it('creates an append-only tenant-scoped audit table', () => {
    expect(migration428).toMatch(/CREATE TABLE IF NOT EXISTS developer_portal_audit_events/i);
    expect(migration428).toMatch(/tenant_id\s+UUID NOT NULL/i);
    expect(migration428).toMatch(/event_type\s+VARCHAR\(60\) NOT NULL/i);
    expect(migration428).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migration428).toMatch(/CREATE POLICY tenant_isolation ON developer_portal_audit_events/i);
  });

  it('covers the API-client lifecycle and OpenAPI download audit event types', () => {
    for (const eventType of [
      'client.created',
      'client.updated',
      'key.issued',
      'key.rotated',
      'key.revoked',
      'openapi.downloaded',
    ]) {
      expect(migration428).toContain(`'${eventType}'`);
    }
  });

  it('blocks update and delete mutations on audit events', () => {
    expect(migration428).toMatch(/prevent_developer_portal_audit_events_mutation/i);
    expect(migration428).toMatch(/BEFORE UPDATE ON developer_portal_audit_events/i);
    expect(migration428).toMatch(/BEFORE DELETE ON developer_portal_audit_events/i);
    expect(migration428).toMatch(/RAISE EXCEPTION 'developer_portal_audit_events is append-only'/i);
  });
});
