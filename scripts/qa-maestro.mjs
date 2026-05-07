#!/usr/bin/env node
// QA harness — Maestro stage wrapper for the Flutter mobile apps.
//
// Discovers Maestro flow files under apps/{patient,staff}/.maestro/*.yaml
// and runs each via `maestro test <flow>`. Captures combined output and
// per-flow exit codes so failures surface as orchestrator findings.
//
// Prerequisites (one-time per dev machine):
//   - Maestro CLI installed and on PATH
//     (https://maestro.mobile.dev/getting-started/installing-maestro)
//   - For Android: an emulator running OR a USB-connected device
//     (run `adb devices` to confirm).
//   - iOS is out of scope for this iteration — see docs/qa-findings/_baseline.md.
//
// Env knobs:
//   QA_MAESTRO_TARGET=patient|staff|all   (default: all)
//   QA_MAESTRO_DEVICE=emulator-5554       (passed to maestro --device)
//
// Layout assumed:
//   apps/patient/.maestro/<flow>.yaml
//   apps/staff/.maestro/<flow>.yaml
//
// Exit code = 0 only if every discovered flow passes. If no flows are
// found, the script exits 0 with a clear "no flows" notice — that is
// itself the signal to author one.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const TARGETS = ['patient', 'staff'];

function log(msg) {
  console.log(`[qa-maestro] ${msg}`);
}

function discoverFlows(target) {
  const dir = path.join(repoRoot, 'apps', target, '.maestro');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile());
}

function runMaestro(flowPath, deviceFlag) {
  log(`running ${path.relative(repoRoot, flowPath)}`);
  const args = ['test', ...(deviceFlag ? ['--device', deviceFlag] : []), flowPath];
  const result = spawnSync('maestro', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

function main() {
  const targetEnv = (process.env.QA_MAESTRO_TARGET || 'all').toLowerCase();
  const targets = targetEnv === 'all' ? TARGETS : [targetEnv].filter((t) => TARGETS.includes(t));
  if (!targets.length) {
    log(`unknown QA_MAESTRO_TARGET=${targetEnv}; valid: patient|staff|all`);
    process.exit(2);
  }

  const deviceFlag = process.env.QA_MAESTRO_DEVICE || '';

  // Maestro CLI presence check (clear error beats a cryptic ENOENT).
  const probe = spawnSync('maestro', ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (probe.status !== 0) {
    log('FAIL: maestro CLI not on PATH. Install from https://maestro.mobile.dev/getting-started/installing-maestro');
    process.exit(127);
  }
  log(`maestro version: ${(probe.stdout || '').trim()}`);

  const allFlows = targets.flatMap((t) => discoverFlows(t).map((f) => ({ target: t, flow: f })));
  if (!allFlows.length) {
    log('no Maestro flows found yet — author one under apps/<patient|staff>/.maestro/<name>.yaml');
    log('exiting 0 (this is not a failure on its own; the harness will start exercising flows once they exist).');
    process.exit(0);
  }

  let failed = 0;
  for (const { target, flow } of allFlows) {
    log(`-- target=${target} flow=${path.basename(flow)}`);
    const code = runMaestro(flow, deviceFlag);
    if (code !== 0) {
      failed += 1;
      log(`FAIL ${target}/${path.basename(flow)} exit=${code}`);
    }
  }

  log(`done — ${allFlows.length - failed}/${allFlows.length} flows passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
