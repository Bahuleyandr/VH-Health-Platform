import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const isWindows = process.platform === 'win32';

export const ciEnv = {
  NEXT_PUBLIC_API_URL: 'http://localhost:5000',
  NEXT_PUBLIC_API_KEY: 'test-api-key',
  NEXT_PUBLIC_APP_NAME: 'VHHealth Admin',
  NEXT_PUBLIC_APP_ORIGIN: 'http://localhost:3000',
  NEXT_PUBLIC_WS_URL: 'ws://localhost:5000',
  NEXT_PUBLIC_X_API_KEY: 'test-api-key',
};

export function commandSpec(command, args) {
  if (isWindows && command === 'dart') {
    const flutterRoot = process.env.FLUTTER_ROOT || 'D:\\Dev\\Tools\\flutter';
    const dartExe = join(flutterRoot, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe');
    if (existsSync(dartExe)) return { command: dartExe, args };
  }

  if (isWindows && ['npm', 'npx', 'flutter', 'melos'].includes(command)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }

  return { command, args };
}

export function relativeCwd(cwd = repoRoot) {
  return cwd.replace(`${repoRoot}\\`, '').replace(`${repoRoot}/`, '');
}

export function run(command, args, options = {}) {
  const started = Date.now();
  const displayCwd = options.cwd ? relativeCwd(options.cwd) : '.';
  console.log(`\n$ ${command} ${args.join(' ')}  [${displayCwd}]`);

  const spec = commandSpec(command, args);
  const result = spawnSync(spec.command, spec.args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: 'inherit',
    shell: false,
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed after ${seconds}s`);
  }
  console.log(`ok (${seconds}s)`);
}

export function checkCommand(command, args = ['--version']) {
  const spec = commandSpec(command, args);
  const result = spawnSync(spec.command, spec.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });
  return result.status === 0;
}

