import { notificationOutboxAutoReplayEnabled } from '../../config/notificationOutboxConfig.js';

describe('notification outbox auto-replay kill switch', () => {
  it('defaults on and accepts only exact canonical booleans', () => {
    expect(notificationOutboxAutoReplayEnabled({})).toBe(true);
    expect(notificationOutboxAutoReplayEnabled({
      NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED: 'true',
    })).toBe(true);
    expect(notificationOutboxAutoReplayEnabled({
      NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED: 'false',
    })).toBe(false);
  });

  it.each(['FALSE', ' false ', '0', 'yes', ''])('rejects ambiguous value %j', (value) => {
    expect(() => notificationOutboxAutoReplayEnabled({
      NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED: value,
    })).toThrow(/must be exactly "true" or "false"/);
  });
});
