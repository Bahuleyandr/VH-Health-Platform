import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../migrations/699_sms_provider_configs.sql', import.meta.url),
  'utf8',
);
const twilioGuardMigration = readFileSync(
  new URL('../../migrations/711_sms_twilio_enabled_config_guard.sql', import.meta.url),
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

  it('fails retained upgrades and future writes closed on enabled Twilio rows without account_sid', () => {
    expect(twilioGuardMigration).toMatch(
      /WHERE provider = 'twilio'[\s\S]*enabled = true[\s\S]*NULLIF\(BTRIM\(account_sid\), ''\) IS NULL/i,
    );
    expect(twilioGuardMigration).toMatch(/RAISE EXCEPTION[\s\S]*no account_sid/i);
    expect(twilioGuardMigration).toMatch(
      /chk_sms_provider_config_twilio_live_account_sid[\s\S]*provider <> 'twilio'[\s\S]*OR NOT enabled[\s\S]*account_sid/i,
    );
  });
});
