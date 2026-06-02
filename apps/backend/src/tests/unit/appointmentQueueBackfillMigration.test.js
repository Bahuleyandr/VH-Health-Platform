import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/261_backfill_appointment_queues.sql',
);

describe('migration 261 — appointment queue backfill', () => {
  let sql;

  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it('creates missing appointment queues from existing active appointments', () => {
    expect(sql).toMatch(/INSERT INTO appointment_queues/i);
    expect(sql).toMatch(/FROM appointments a/i);
    expect(sql).toMatch(/a\.queue_id IS NULL/i);
    expect(sql).toMatch(/COALESCE\(a\.status, ''\) NOT IN \('CANCELLED', 'NO_SHOW'\)/i);
    expect(sql).toMatch(/jsonb_build_object\('source', 'migration_261_backfill'\)/i);
  });

  it('links appointments back to the matched queue id', () => {
    expect(sql).toMatch(/UPDATE appointments a[\s\S]*SET queue_id = m\.queue_id/i);
    expect(sql).toMatch(/JOIN appointment_queues q/i);
    expect(sql).toMatch(/q\.queue_kind = c\.queue_kind/i);
    expect(sql).toMatch(/COALESCE\(q\.doctor_id, 0\) = COALESCE\(c\.doctor_id, 0\)/i);
  });

  it('records initial queue status history for backfilled queues', () => {
    expect(sql).toMatch(/INSERT INTO appointment_queue_status_history/i);
    expect(sql).toMatch(/'Backfilled from existing appointments'/i);
    expect(sql).toMatch(/q\.metadata->>'source' = 'migration_261_backfill'/i);
  });
});
