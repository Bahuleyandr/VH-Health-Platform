#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const image = process.env.VH_DB_GUARDRAILS_IMAGE || 'pgvector/pgvector:pg16';
const keepContainer = process.env.VH_KEEP_DOCKER_TEST_DB === 'true';
const portStart = Number(process.env.VH_DB_GUARDRAILS_PORT || 55433);
const isWindows = process.platform === 'win32';
const runTests = process.argv.includes('--with-tests') ||
  process.env.VH_DB_GUARDRAILS_RUN_TESTS === 'true';

function resolvePublishedDockerHost() {
  if (process.env.VH_DB_GUARDRAILS_HOST) {
    return process.env.VH_DB_GUARDRAILS_HOST;
  }

  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost?.startsWith('tcp://')) {
    try {
      return new URL(dockerHost).hostname;
    } catch {
      // Fall back to localhost if DOCKER_HOST is malformed.
    }
  }

  return '127.0.0.1';
}

function commandName(command) {
  return isWindows && command === 'npm' ? 'npm.cmd' : command;
}

function run(command, args, options = {}) {
  const result = spawnSync(commandName(command), args, {
    cwd: options.cwd || backendRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (!options.capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    const detail = output ? `\n${output}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`);
  }

  return result.stdout || '';
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

async function findPort() {
  for (let port = portStart; port < portStart + 50; port++) {
    if (await canBind(port)) return port;
  }
  throw new Error(`No free local port found from ${portStart} to ${portStart + 49}`);
}

function dockerAvailable() {
  const result = spawnSync(commandName('docker'), ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return result.status === 0;
}

function runNodeScript(script, args = [], options = {}) {
  run(process.execPath, [path.join('scripts', script), ...args], options);
}

function waitForPostgres(containerName) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60_000) {
    const result = spawnSync(commandName('docker'), [
      'exec',
      containerName,
      'pg_isready',
      '-U',
      'postgres',
      '-d',
      'vhhealth_test',
    ], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`Postgres in ${containerName} did not become ready within 60 seconds`);
}

function waitForHostPort(host, port) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= 60_000) {
          reject(new Error(`${host}:${port} did not become reachable within 60 seconds`));
        } else {
          setTimeout(attempt, 1000);
        }
      });
    }
    attempt();
  });
}

async function waitForDatabase(databaseUrl) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < 60_000) {
    const client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(
    `Database at ${databaseUrl} did not accept SQL connections within 60 seconds: ` +
    `${lastError instanceof Error ? lastError.message : lastError}`
  );
}

if (!dockerAvailable()) {
  throw new Error('Docker is required for the Docker-backed DB guardrail run.');
}

const port = await findPort();
const containerName = `vhhealth-db-guardrails-${port}`;
const publishedHost = resolvePublishedDockerHost();
const databaseUrl = new URL(`postgresql://${publishedHost}:${port}/vhhealth_test`);
databaseUrl.username = 'postgres';
databaseUrl.password = 'postgres';
const connectionString = databaseUrl.toString();
const env = {
  DATABASE_URL: connectionString,
  TEST_DATABASE_URL: connectionString,
  PGPASSWORD: 'postgres',
  VH_ALLOW_NON_TEST_DATA_SEED: 'true',
  NODE_ENV: 'test',
};

try {
  run('docker', ['rm', '-f', containerName], { capture: true });
} catch {
  // No existing container to remove.
}

try {
  console.log(`Starting disposable ${image} on ${publishedHost}:${port}`);
  run('docker', [
    'run',
    '-d',
    '--name',
    containerName,
    '-p',
    `${port}:5432`,
    '-e',
    'POSTGRES_USER=postgres',
    '-e',
    'POSTGRES_PASSWORD=postgres',
    '-e',
    'POSTGRES_DB=vhhealth_test',
    image,
  ]);
  waitForPostgres(containerName);
  await waitForHostPort(publishedHost, port);
  await waitForDatabase(connectionString);

  console.log(`Running DB guardrails against disposable Postgres on ${publishedHost}:${port}`);
  run(process.execPath, [
    path.join('node_modules', 'prisma', 'build', 'index.js'),
    'generate',
  ], { env });
  runNodeScript('ensure-pgvector-extension.mjs', [], { env });
  runNodeScript('ci-setup-db.mjs', [], { env });
  runNodeScript('check-schema-drift.mjs', [], { env });
  runNodeScript('check-db-contracts.mjs', [], { env });
  runNodeScript('seed-comprehensive-test-data.mjs', [], { env });
  runNodeScript('check-db-contracts.mjs', ['--require-seeded'], { env });
  runNodeScript('ci-schema-drift.mjs', [], { env });
  if (runTests) {
    console.log('Running backend Jest tests against disposable Postgres.');
    runNodeScript('run-ci-jest.mjs', [], { env });
  }
  console.log('Docker-backed DB guardrails passed.');
} finally {
  if (keepContainer) {
    console.log(`Keeping ${containerName} running because VH_KEEP_DOCKER_TEST_DB=true.`);
  } else {
    run('docker', ['rm', '-f', containerName], { capture: true });
  }
}
