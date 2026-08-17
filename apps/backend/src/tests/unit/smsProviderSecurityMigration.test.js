import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../migrations/699_sms_provider_configs.sql', import.meta.url),
  'utf8',
);

describe('SMS provider callback secret migration contract', () => {
  it('requires both lookup hash and encrypted token on every enabled real provider', () => {
    expect(migration).toMatch(/callback_token_hash\s+CHAR\(64\)/i);
    expect(migration).toMatch(/callback_token_ciphertext\s+TEXT/i);
    expect(migration).toMatch(
      /chk_sms_provider_config_live_shape[\s\S]*callback_token_hash IS NOT NULL[\s\S]*callback_token_ciphertext IS NOT NULL/i,
    );
  });
});
