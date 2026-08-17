const AUTO_REPLAY_FLAG = 'NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED';

export function notificationOutboxAutoReplayEnabled(env = process.env) {
  const raw = env?.[AUTO_REPLAY_FLAG];
  if (raw === undefined) return true;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new TypeError(`${AUTO_REPLAY_FLAG} must be exactly "true" or "false"`);
}
