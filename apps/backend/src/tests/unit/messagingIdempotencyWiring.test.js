import fs from 'node:fs';

describe('staff messaging idempotency wiring', () => {
  const source = fs.readFileSync(
    new URL('../../routes/messaging/messagingRoutes.js', import.meta.url),
    'utf8'
  );

  it('requires an idempotency key for direct sends and broadcasts', () => {
    expect(source).toMatch(
      /router\.post\([\s\S]*?'\/send'[\s\S]*?requireIdempotencyKey\(\{\s*required:\s*true,\s*scope:\s*'staff_message_send'\s*\}\)/
    );
    expect(source).toMatch(
      /router\.post\([\s\S]*?'\/broadcast'[\s\S]*?requireIdempotencyKey\(\{\s*required:\s*true,\s*scope:\s*'staff_message_broadcast'\s*\}\)/
    );
  });
});
