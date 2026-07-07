import {
  assertPrivilegeForGate,
  isGateEnabled,
  privilegeKey,
  severityForDaysRemaining,
} from '../../services/staff/credentialingService.js';

describe('credentialingService helpers', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('normalizes privilege aliases into catalog keys', () => {
    expect(privilegeKey('CHEMO_ADMINISTER')).toBe('chemo_administration');
    expect(privilegeKey('Anaesthetist')).toBe('anesthesia_finalize');
    expect(privilegeKey('Controlled Substance eRx')).toBe('controlled_substance_prescribe');
  });

  test('maps expiry windows to severity bands', () => {
    expect(severityForDaysRemaining(3)).toBe('critical');
    expect(severityForDaysRemaining(30)).toBe('high');
    expect(severityForDaysRemaining(60)).toBe('medium');
    expect(severityForDaysRemaining(90)).toBe('low');
  });

  test('recognizes explicit env-enabled gates only', () => {
    process.env.TEST_CREDENTIAL_GATE = 'true';
    process.env.TEST_CREDENTIAL_GATE_OFF = '0';
    expect(isGateEnabled('TEST_CREDENTIAL_GATE')).toBe(true);
    expect(isGateEnabled('TEST_CREDENTIAL_GATE_OFF')).toBe(false);
  });

  test('returns a non-enforced verdict without touching the database when flag is off', async () => {
    await expect(
      assertPrivilegeForGate({
        staffUid: 'not-a-uuid',
        privilegeName: 'primary surgeon',
        enabled: false,
      }),
    ).resolves.toMatchObject({
      enforced: false,
      allowed: true,
      reason: 'flag_disabled',
      privilege_key: 'primary_surgeon',
    });
  });
});
