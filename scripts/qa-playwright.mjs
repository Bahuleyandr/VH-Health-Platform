#!/usr/bin/env node
// QA harness — Playwright stage wrapper.
//
// Drives the existing admin Playwright suite (apps/admin/e2e/*.spec.ts)
// as one orchestrator stage so failures land in qa-runs/<run_id>/ui-admin/
// alongside the API smokes.
//
// Default: runs the `smoke` project against http://127.0.0.1:3201. Caller
// can override via env:
//   PLAYWRIGHT_BASE_URL=http://localhost:3001 node scripts/qa-playwright.mjs
//   QA_PW_PROJECT=route-crawl ...     # filter playwright project
//   QA_PW_GREP=login ...              # -g pattern
//
// The orchestrator invokes this with cwd = repo root; npm is forwarded
// into apps/admin via `npm --prefix`.

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const adminDir = path.join(repoRoot, 'apps', 'admin');

function log(msg) {
  console.log(`[qa-playwright] ${msg}`);
}

async function main() {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3201';
  const project = process.env.QA_PW_PROJECT || '';
  const grep = process.env.QA_PW_GREP || '';

  // npx playwright test forwards correctly through the admin's local install.
  const args = ['--prefix', adminDir, 'exec', '--', 'playwright', 'test', '--reporter=list'];
  if (project) args.push('--project', project);
  if (grep) args.push('-g', grep);

  log(`base_url=${baseUrl} project=${project || 'default'} grep=${grep || '<none>'}`);

  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const cmdArgs = isWindows ? ['/d', '/s', '/c', 'npm', ...args] : args;

  const child = spawn(cmd, cmdArgs, {
    cwd: repoRoot,
    env: { ...process.env, PLAYWRIGHT_BASE_URL: baseUrl },
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      log(`exited via signal ${signal}`);
      process.exit(143);
    }
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error('[qa-playwright] crashed:', err);
  process.exit(1);
});
