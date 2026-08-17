import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const publishedMigration = readFileSync(
  new URL('../../migrations/699_sms_provider_configs.sql', import.meta.url),
  'utf8',
);
const twilioGuardMigration = readFileSync(
  new URL('../../migrations/711_sms_twilio_enabled_config_guard.sql', import.meta.url),
  'utf8',
);

describe('SMS provider callback secret migration contract', () => {
  it('keeps published 699 immutable and adds the encrypted token only in 711', () => {
    expect(createHash('sha256').update(
      publishedMigration.replace(/\r\n/g, '\n'),
    ).digest('hex')).toBe('d6f57cd54a2bf7f0f6dfb336b80b1bd5f86357d29f72642e3388b95153f7f808');
    expect(publishedMigration).toMatch(/callback_token_hash\s+CHAR\(64\)/i);
    expect(publishedMigration).not.toMatch(/callback_token_ciphertext/i);
    expect(twilioGuardMigration).toMatch(
      /ADD COLUMN IF NOT EXISTS callback_token_ciphertext TEXT/i,
    );
    expect(twilioGuardMigration).toMatch(
      /chk_sms_provider_config_live_shape[\s\S]*callback_token_hash IS NOT NULL[\s\S]*BTRIM\(callback_token_ciphertext\)[\s\S]*IS NOT NULL/i,
    );
  });

  it('disables incomplete retained rows and rejects future enabled Twilio rows without account_sid', () => {
    expect(twilioGuardMigration).toMatch(
      /UPDATE sms_provider_configs[\s\S]*SET enabled = false[\s\S]*incomplete_enabled_sms_provider_config/i,
    );
    expect(twilioGuardMigration).toMatch(
      /chk_sms_provider_config_twilio_live_account_sid[\s\S]*provider <> 'twilio'[\s\S]*OR NOT enabled[\s\S]*account_sid/i,
    );
  });
});
