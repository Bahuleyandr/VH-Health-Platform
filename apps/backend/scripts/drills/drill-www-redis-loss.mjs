// Drill — the REAL src/bin/www.js under Redis loss (2026-08-15 drill
// remediation, Finding 2 verification). No mocks: spawns the actual server
// process and observes exit codes, log lines, and liveness.
//
// Scenarios:
//   strict-exit        REDIS_REQUIRE_SENTINEL=true + all Sentinels on closed
//                      local ports. Expected: the documented fail-fast now
//                      EXECUTES — "refusing to start" then exit(1) within
//                      REDIS_INIT_TIMEOUT_MS (+ boot overhead). Before the
//                      fix, initRedis() never settled and the process hung
//                      forever (neither ready nor crash-looping).
//   nonstrict-degraded REDIS_URL on a closed port, non-strict. Expected: log
//                      "running without cache", start degraded, keep serving.
//   midflight          Connect to a live fake-redis, hard-kill it mid-flight.
//                      Expected: NO process exit (a transient blip must not
//                      crash-loop), and reconnection once the node returns.
//
// Requires: the backend's usual required env (a filled .env is fine — the
// drill's overrides win because dotenv never overrides existing env), with
// DATABASE_URL pointing at a migrated scratch DB. NEVER vhhealth_test.
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeRedis } from './fake-redis.mjs';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scenario = process.argv[2];

const closedPort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// Every scenario fully OWNS the Redis shape: inherited REDIS_* vars are
// dropped before the scenario's own are applied. (validateEnv forbids
// REDIS_URL when REDIS_REQUIRE_SENTINEL=true, so a leaked REDIS_URL — from the
// shell or a .env, which dotenv only reads for vars not already set — would
// fail env validation instead of exercising the Redis boot gate.)
const REDIS_ENV_KEYS = [
  'REDIS_URL', 'REDIS_REQUIRE_SENTINEL', 'REDIS_SENTINEL_HOSTS',
  'REDIS_SENTINEL_MASTER', 'REDIS_USERNAME', 'REDIS_SENTINEL_USERNAME',
  'REDIS_PASSWORD', 'REDIS_SENTINEL_PASSWORD', 'REDIS_INIT_TIMEOUT_MS',
  'REDIS_COMMAND_TIMEOUT_MS',
];

function startWww(extraEnv) {
  const env = { ...process.env };
  for (const key of REDIS_ENV_KEYS) delete env[key];
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, ['src/bin/www.js'], {
    cwd: backendRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk) => {
    output += String(chunk);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  return {
    child,
    getOutput: () => output,
    waitForLine: (pattern, timeoutMs) => new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (pattern.test(output)) {
          clearInterval(tick);
          resolve(true);
        } else if (Date.now() - started > timeoutMs || child.exitCode !== null) {
          clearInterval(tick);
          resolve(false);
        }
      }, 200);
    }),
    waitForExit: (timeoutMs) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ exited: false, code: null }), timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ exited: true, code });
      });
    }),
  };
}

const result = { scenario };

if (scenario === 'strict-exit') {
  const [p1, p2, p3] = await Promise.all([closedPort(), closedPort(), closedPort()]);
  const t0 = Date.now();
  const www = startWww({
    PORT: '5097',
    NODE_ENV: 'development',
    REDIS_REQUIRE_SENTINEL: 'true',
    REDIS_SENTINEL_HOSTS: `127.0.0.1:${p1},127.0.0.1:${p2},127.0.0.1:${p3}`,
    REDIS_SENTINEL_MASTER: 'vhhealth-primary',
    REDIS_USERNAME: 'vhhealth-backend',
    REDIS_SENTINEL_USERNAME: 'vhhealth-discovery',
    REDIS_PASSWORD: 'a'.repeat(32),
    REDIS_SENTINEL_PASSWORD: 'b'.repeat(32),
    REDIS_INIT_TIMEOUT_MS: '8000',
  });
  const exit = await www.waitForExit(240000);
  result.elapsedMs = Date.now() - t0;
  result.exited = exit.exited;
  result.exitCode = exit.code;
  result.sawRefusal = /refusing to start/.test(www.getOutput());
  result.sawDeadline = /did not complete within/.test(www.getOutput());
  result.verdict = exit.exited && exit.code === 1 && result.sawRefusal ? 'PASS' : 'FAIL';
} else if (scenario === 'nonstrict-degraded') {
  const port = await closedPort();
  const t0 = Date.now();
  const www = startWww({
    PORT: '5096', NODE_ENV: 'development', REDIS_URL: `redis://127.0.0.1:${port}`, REDIS_REQUIRE_SENTINEL: 'false',
  });
  const degraded = await www.waitForLine(/running without cache/, 240000);
  const listening = await www.waitForLine(/Backend running on/, 240000);
  result.elapsedMs = Date.now() - t0;
  result.sawDegradedLog = degraded;
  result.listening = listening;
  result.stillAlive = www.child.exitCode === null;
  result.verdict = degraded && listening && result.stillAlive ? 'PASS' : 'FAIL';
  www.child.kill();
} else if (scenario === 'midflight') {
  const fake = await startFakeRedis(0);
  const www = startWww({
    PORT: '5095', NODE_ENV: 'development', REDIS_URL: `redis://127.0.0.1:${fake.port}`, REDIS_REQUIRE_SENTINEL: 'false',
  });
  const listening = await www.waitForLine(/Backend running on/, 240000);
  result.listening = listening;
  if (listening) {
    await fake.kill();
    // A transient loss must not exit the process.
    await new Promise((r) => setTimeout(r, 8000));
    result.aliveAfterKill = www.child.exitCode === null;
    // Bring the node back on the SAME port; ioredis's infinite retryStrategy
    // should reconnect without any process involvement. The first "Redis
    // ready" was boot; a SECOND one is the reconnect.
    const revived = await startFakeRedis(fake.port);
    const reconnectDeadline = Date.now() + 60000;
    let readyCount = 0;
    while (Date.now() < reconnectDeadline) {
      readyCount = (www.getOutput().match(/Redis ready/g) || []).length;
      if (readyCount >= 2 || www.child.exitCode !== null) break;
       
      await new Promise((r) => setTimeout(r, 250));
    }
    result.readyCount = readyCount;
    result.reconnected = readyCount >= 2 && www.child.exitCode === null;
    await revived.kill();
    result.verdict = result.aliveAfterKill && result.reconnected ? 'PASS' : 'FAIL';
  } else {
    result.verdict = 'FAIL';
  }
  www.child.kill();
} else {
  console.error('Usage: node scripts/drills/drill-www-redis-loss.mjs <strict-exit|nonstrict-degraded|midflight>');
  process.exit(2);
}

console.log(`\n=== DRILL RESULT (${scenario}) ===`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.verdict === 'PASS' ? 0 : 1);
