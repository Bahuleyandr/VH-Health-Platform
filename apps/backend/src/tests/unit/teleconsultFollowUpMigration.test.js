import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_PATH = path.resolve(
  __dirname,
  '../../migrations/457_teleconsult_follow_up_settings.sql',
);
const LOOPS_PATH = path.resolve(
  __dirname,
  '../../migrations/458_teleconsult_follow_up_loops.sql',
);

describe('NL9-P3 teleconsult follow-up migrations', () => {
  let settingsSql;
  let loopsSql;

  beforeAll(() => {
    settingsSql = fs.readFileSync(SETTINGS_PATH, 'utf8');
    loopsSql = fs.readFileSync(LOOPS_PATH, 'utf8');
  });

  it('uses only the assigned 457-458 migration block', () => {
    expect(path.basename(SETTINGS_PATH)).toBe('457_teleconsult_follow_up_settings.sql');
    expect(path.basename(LOOPS_PATH)).toBe('458_teleconsult_follow_up_loops.sql');
  });

  it('ships default triggers behind a disabled tenant flag', () => {
    expect(settingsSql).toMatch(/CREATE TABLE IF NOT EXISTS teleconsult_follow_up_settings/i);
    expect(settingsSql).toMatch(/enabled BOOLEAN NOT NULL DEFAULT false/i);
    for (const trigger of [
      'clinician_follow_up_due_date',
      'investigation_ordered',
      'prescription_created',
      'secure_message_fallback',
      'teleconsult_completed',
    ]) {
      expect(settingsSql).toContain(`"${trigger}": {"enabled": true`);
    }
  });

  it('creates loop, step, and event audit tables with tenant RLS', () => {
    for (const table of [
      'engagement_follow_up_loops',
      'engagement_follow_up_steps',
      'engagement_follow_up_events',
    ]) {
      expect(loopsSql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
      expect(loopsSql).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(loopsSql).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
      expect(loopsSql).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON ${table}`, 'i'));
    }
  });

  it('prevents duplicate open loops for the same teleconsult trigger', () => {
    expect(loopsSql).toMatch(/uq_follow_up_loop_open_source/i);
    expect(loopsSql).toMatch(/source_type, source_ref, loop_type/i);
    expect(loopsSql).toMatch(/WHERE status IN \('open', 'scheduled', 'waiting_patient', 'staff_review'\)/i);
  });
});
