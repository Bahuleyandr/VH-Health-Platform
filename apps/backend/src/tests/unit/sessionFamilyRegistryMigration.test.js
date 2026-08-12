import fs from 'fs';

const migration = fs.readFileSync(
  new URL('../../migrations/662_user_active_session_identity.sql', import.meta.url),
  'utf8',
);

describe('migration 662 active-session identity persistence', () => {
  it('adds nullable family and device selectors for legacy-row compatibility', () => {
    expect(migration).toMatch(/ALTER TABLE public\.user_active_sessions/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS session_family_id TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS stable_device_id UUID/i);
    expect(migration).not.toMatch(/session_family_id TEXT\s+NOT NULL/i);
    expect(migration).not.toMatch(/stable_device_id UUID\s+NOT NULL/i);
  });

  it('does not invent selector values for legacy rows', () => {
    expect(migration).not.toMatch(/UPDATE\s+(?:public\.)?user_active_sessions/i);
  });
});
