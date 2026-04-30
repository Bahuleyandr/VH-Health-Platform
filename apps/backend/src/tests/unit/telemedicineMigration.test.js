/**
 * Phase B1 — verifies migration 117 declares the six telemedicine
 * foundation tables with the constraints + indexes the service relies on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/117_telemedicine_foundation.sql',
);

describe('migration 117 — telemedicine foundation', () => {
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
    ['teleconsultations'],
    ['video_sessions'],
    ['chat_sessions'],
    ['chat_session_messages'],
    ['remote_prescriptions'],
    ['teleconsult_provider_configs'],
  ])('declares %s with IF NOT EXISTS', (table) => {
    expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  });

  it('every table is tenant-scoped', () => {
    const tables = sql.match(/CREATE TABLE IF NOT EXISTS \w+/gi) || [];
    expect(tables.length).toBe(6);
    const tenantRefs = sql.match(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\)/gi) || [];
    expect(tenantRefs.length).toBe(6);
  });

  it('teleconsultations allow-lists 7 statuses', () => {
    const statuses = ['scheduled', 'waiting', 'in_progress', 'completed', 'cancelled', 'no_show', 'failed'];
    for (const s of statuses) expect(sql).toMatch(new RegExp(`'${s}'`));
    expect(sql).toMatch(/CHECK \(status IN \('scheduled', 'waiting', 'in_progress', 'completed', 'cancelled', 'no_show', 'failed'\)\)/i);
  });

  it('teleconsultations allow-lists 4 consult_type values', () => {
    expect(sql).toMatch(/CHECK \(consult_type IN \('video', 'chat', 'audio', 'hybrid'\)\)/i);
  });

  it('video_sessions allow-lists 7 providers', () => {
    expect(sql).toMatch(/CHECK \(provider IN \('zoom', 'daily', 'jitsi', 'twilio', 'agora', 'webrtc_native', 'other'\)\)/i);
  });

  it('chat_session_messages allow-lists authored_role + body_kind', () => {
    expect(sql).toMatch(/CHECK \(authored_role IN \('patient', 'doctor', 'staff', 'system'\)\)/i);
    expect(sql).toMatch(/CHECK \(body_kind IN \('text', 'system_event', 'alert', 'attachment_card'\)\)/i);
  });

  it('remote_prescriptions allow-lists status + signature_kind', () => {
    expect(sql).toMatch(/CHECK \(status IN \('draft', 'issued', 'fulfilled', 'cancelled', 'recalled'\)\)/i);
    expect(sql).toMatch(/digital_signature_kind IS NULL OR digital_signature_kind IN \(\s*'doctor_signed', 'aadhaar_esign', 'dsc', 'platform_attested', 'unsigned'\s*\)/i);
  });

  it('teleconsult_provider_configs is unique per (tenant, provider)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS teleconsult_provider_configs[\s\S]*UNIQUE \(tenant_id, provider\)/i);
  });

  it('teleconsult_provider_configs enforces single default per tenant via partial unique index', () => {
    expect(sql).toMatch(/uq_provider_config_default[\s\S]*WHERE is_default = true/i);
  });

  it('declares hot-path indexes', () => {
    const expected = [
      /idx_teleconsultations_tenant_status/i,
      /idx_teleconsultations_patient_status/i,
      /idx_teleconsultations_doctor_window/i,
      /idx_video_sessions_consult/i,
      /idx_video_sessions_tenant_status/i,
      /idx_chat_sessions_tenant_status/i,
      /idx_chat_messages_session_time/i,
      /idx_chat_messages_tenant_unread/i,
      /idx_remote_rx_consult/i,
      /idx_remote_rx_tenant_status/i,
    ];
    for (const re of expected) expect(sql).toMatch(re);
  });

  it('chat_messages partial index for unread messages only', () => {
    expect(sql).toMatch(/idx_chat_messages_tenant_unread[\s\S]*WHERE read_by_recipient_at IS NULL/i);
  });
});
