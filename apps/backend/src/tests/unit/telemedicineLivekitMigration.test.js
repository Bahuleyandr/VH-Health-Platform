/**
 * NL-3 P1 — verifies migration 361 deliberately adds LiveKit as a first-class
 * teleconsult video provider instead of hiding it under "other".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/361_video_sessions_livekit_provider.sql',
);

describe('migration 361 — livekit teleconsult provider', () => {
  let sql;

  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('updates both migration-117 provider CHECK constraints', () => {
    expect(sql).toMatch(/ALTER TABLE video_sessions[\s\S]*DROP CONSTRAINT IF EXISTS video_sessions_provider_check/i);
    expect(sql).toMatch(/ALTER TABLE video_sessions[\s\S]*ADD CONSTRAINT video_sessions_provider_check[\s\S]*'livekit'/i);
    expect(sql).toMatch(/ALTER TABLE teleconsult_provider_configs[\s\S]*DROP CONSTRAINT IF EXISTS teleconsult_provider_configs_provider_check/i);
    expect(sql).toMatch(/ALTER TABLE teleconsult_provider_configs[\s\S]*ADD CONSTRAINT teleconsult_provider_configs_provider_check[\s\S]*'livekit'/i);
  });

  it('does not add teleconsultation consent columns that migration 117 already owns', () => {
    expect(sql).not.toMatch(/ADD COLUMN[\s\S]*(remote_consent_id|remote_consent_signed_at|recording_consent)/i);
  });
});
