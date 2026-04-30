/**
 * Verifies migration 112 adds the demographic-slice columns + indexes
 * driftCanaryService relies on for bias monitoring (S3).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/112_clinical_ai_bias_monitoring.sql',
);

describe('migration 112 — bias monitoring schema', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(400);
  });

  it('adds slice_attributes to clinical_ai_canary_cases', () => {
    expect(sql).toMatch(/ALTER TABLE clinical_ai_canary_cases\s+ADD COLUMN IF NOT EXISTS slice_attributes JSONB/i);
  });

  it('adds slice_metrics + bias_signals to clinical_ai_canary_runs', () => {
    expect(sql).toMatch(/ALTER TABLE clinical_ai_canary_runs[\s\S]*slice_metrics JSONB/i);
    expect(sql).toMatch(/ALTER TABLE clinical_ai_canary_runs[\s\S]*bias_signals JSONB/i);
  });

  it('adds slice_metrics + bias_signals to clinical_ai_model_eval_runs', () => {
    expect(sql).toMatch(/ALTER TABLE clinical_ai_model_eval_runs[\s\S]*slice_metrics JSONB/i);
    expect(sql).toMatch(/ALTER TABLE clinical_ai_model_eval_runs[\s\S]*bias_signals JSONB/i);
  });

  it('creates indexes for every demographic slice axis', () => {
    const axes = ['age_band', 'sex', 'language', 'disease_group', 'facility_id'];
    for (const axis of axes) {
      const re = new RegExp(`CREATE INDEX IF NOT EXISTS [\\w_]+\\s+ON clinical_ai_canary_cases\\s*\\(\\(slice_attributes->>'${axis}'\\)\\)`, 'i');
      expect(sql).toMatch(re);
    }
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it('uses idempotent ADD COLUMN IF NOT EXISTS so re-applying is safe', () => {
    const addColumns = sql.match(/ADD COLUMN IF NOT EXISTS/gi) || [];
    // 1 on canary_cases, 2 on canary_runs, 2 on model_eval_runs.
    expect(addColumns.length).toBeGreaterThanOrEqual(5);
  });
});
