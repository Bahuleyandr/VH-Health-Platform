import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RedisStore } from 'rate-limit-redis';

function backendAclCommands() {
  const sourcePath = fileURLToPath(new URL(
    '../../../../../infra/kubernetes/base/redis/config/sentinel-discovery.sh',
    import.meta.url,
  ));
  const source = readFileSync(sourcePath, 'utf8');
  const match = source.match(
    /printf 'user %s on' "\$REDIS_APP_USERNAME"[\s\S]*?printf '([^']+)'/,
  );
  expect(match).not.toBeNull();
  return new Set(
    match[1]
      .split(/\s+/)
      .filter((token) => token.startsWith('+'))
      .map((token) => token.slice(1).toUpperCase()),
  );
}

describe('rate-limit-redis command inventory matches the production ACL', () => {
  it('allows every outer command and every redis.call used by the installed store', async () => {
    const commands = [];
    let scriptIndex = 0;
    const store = new RedisStore({
      prefix: 'rl:acl-contract:',
      sendCommand: async (...command) => {
        commands.push(command);
        if (command[0] === 'SCRIPT' && command[1] === 'LOAD') {
          scriptIndex += 1;
          return `script-sha-${scriptIndex}`;
        }
        if (command[0] === 'EVALSHA') return [1, 60_000];
        return 1;
      },
    });

    await store.init({ windowMs: 60_000 });
    await store.increment('identity');
    await store.get('identity');
    await store.decrement('identity');
    await store.resetKey('identity');

    const required = new Set();
    for (const command of commands) {
      const outer = String(command[0]).toUpperCase();
      required.add(outer === 'SCRIPT' ? `SCRIPT|${String(command[1]).toUpperCase()}` : outer);
      if (outer === 'SCRIPT' && String(command[1]).toUpperCase() === 'LOAD') {
        for (const match of String(command[2]).matchAll(/redis\.call\("([A-Z]+)"/g)) {
          required.add(match[1]);
        }
      }
    }

    const allowed = backendAclCommands();
    expect([...required].sort()).toEqual([
      'DECR',
      'DEL',
      'EVALSHA',
      'GET',
      'INCR',
      'PTTL',
      'SCRIPT|LOAD',
      'SET',
    ]);
    expect([...required].filter((command) => !allowed.has(command))).toEqual([]);
    expect(allowed.has('CONFIG')).toBe(false);
    expect(allowed.has('REPLICAOF')).toBe(false);
    expect(allowed.has('@ALL')).toBe(false);
  });
});
