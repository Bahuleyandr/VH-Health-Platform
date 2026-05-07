#!/usr/bin/env node
// QA harness — orchestrator.
//
// Drives a full QA pass against the local smoke environment:
//   1. Probes that backend (:5206) and admin proxy (:3201) are reachable.
//   2. Runs scripts/qa-reset.mjs (guardrails enforced there).
//   3. Sequentially runs the wrapped PowerShell smokes, capturing stdout +
//      stderr per stage under qa-runs/<run_id>/<stage>/.
//   4. Writes qa-runs/<run_id>/summary.json with pass/fail per stage and
//      reproducibility metadata (run_id, git_sha, started/finished_at,
//      seed_version pulled from qa_seed_meta).
//
// Stages can be selected via --stages reset,admin,patient,staff,clinical
// (default). Opt-in stages:
//   --include-role     adds smoke-staff-role-workflows.ps1 (needs VH_BASE_URL).
//   --include-desktop  adds smoke-staff-desktop.ps1 (needs Flutter on Windows).
//   --include-ui-admin   adds Playwright run against admin (needs admin :3201).
//   --include-ui-mobile  adds Maestro run against patient/staff Flutter apps.
//
// On failure: orchestrator does NOT mutate product code (report mode is the
// default; fix mode is gated per-finding by humans, see docs/qa/MODES.md).

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'apps', 'backend');
const requireFromBackend = createRequire(path.join(backendDir, 'package.json'));
const pg = requireFromBackend('pg');

const DEFAULT_STAGES = ['reset', 'admin', 'patient', 'staff', 'clinical'];
const BACKEND_HEALTH = 'http://127.0.0.1:5206/api/v1/health';
const ADMIN_PROBE = 'http://127.0.0.1:3201/api/proxy/api/v1/health';

const args = parseArgs(process.argv.slice(2));
const runId = args.runId || `${todayUtc()}-${randomUUID().slice(0, 8)}`;
const runDir = path.join(repoRoot, 'qa-runs', runId);
mkdirSync(runDir, { recursive: true });

function parseArgs(argv) {
  const out = {
    stages: null,
    skipReset: false,
    includeRole: false,
    includeDesktop: false,
    includeUiAdmin: false,
    includeUiMobile: false,
    runId: null,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stages') out.stages = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--skip-reset') out.skipReset = true;
    else if (a === '--include-role') out.includeRole = true;
    else if (a === '--include-desktop') out.includeDesktop = true;
    else if (a === '--include-ui-admin') out.includeUiAdmin = true;
    else if (a === '--include-ui-mobile') out.includeUiMobile = true;
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function todayUtc() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function log(msg) {
  if (!args.quiet) console.log(`[qa-orch ${runId}] ${msg}`);
}

async function probe(url, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(url, { method: 'GET' });
      if (r.ok || r.status === 404 || r.status === 401) return true;
    } catch {
      // ignore — will retry / give up below
    }
    await sleep(500);
  }
  return false;
}

async function readSeedMeta() {
  if (!process.env.DATABASE_URL) return null;
  let client;
  try {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const r = await client.query(
      `SELECT seed_version, seeded_at, git_sha
         FROM qa_seed_meta
        ORDER BY id DESC
        LIMIT 1`
    );
    return r.rows[0] || null;
  } catch {
    return null;
  } finally {
    try { if (client) await client.end(); } catch { /* noop */ }
  }
}

function gitSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

function captureRun(stage, command, scriptArgs, options = {}) {
  const stageDir = path.join(runDir, stage);
  mkdirSync(stageDir, { recursive: true });
  const startedAt = new Date().toISOString();
  log(`stage ${stage}: ${command} ${scriptArgs.join(' ')}`);

  const result = spawnSync(command, scriptArgs, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    timeout: options.timeoutMs || 15 * 60 * 1000, // 15min hard cap
  });

  const finishedAt = new Date().toISOString();
  writeFileSync(path.join(stageDir, 'stdout.txt'), result.stdout || '');
  writeFileSync(path.join(stageDir, 'stderr.txt'), result.stderr || '');
  const stageReport = {
    stage,
    command,
    args: scriptArgs,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: result.status,
    timed_out: result.signal === 'SIGTERM' && result.error?.code === 'ETIMEDOUT',
    error_message: result.error?.message || null,
  };
  writeFileSync(path.join(stageDir, 'meta.json'), JSON.stringify(stageReport, null, 2));
  return { ...stageReport, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function pwsh(scriptPath, scriptArgs = []) {
  // PowerShell 7 (pwsh) is required; the repo's smokes run under pwsh.
  return ['pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath, ...scriptArgs]];
}

function runStage(stage) {
  switch (stage) {
    case 'reset': {
      // Direct node — guardrails enforced inside the script.
      return captureRun(stage, process.execPath, [path.join('scripts', 'qa-reset.mjs')]);
    }
    case 'admin': {
      const [cmd, a] = pwsh(path.join('scripts', 'smoke-admin-crud.ps1'));
      return captureRun(stage, cmd, a);
    }
    case 'patient': {
      const [cmd, a] = pwsh(path.join('scripts', 'smoke-patient-routing.ps1'));
      return captureRun(stage, cmd, a);
    }
    case 'staff': {
      const [cmd, a] = pwsh(path.join('scripts', 'smoke-staff-routing.ps1'));
      return captureRun(stage, cmd, a);
    }
    case 'clinical': {
      const [cmd, a] = pwsh(path.join('scripts', 'smoke-staff-clinical-safety.ps1'));
      return captureRun(stage, cmd, a);
    }
    case 'role': {
      const [cmd, a] = pwsh(path.join('scripts', 'smoke-staff-role-workflows.ps1'));
      return captureRun(stage, cmd, a);
    }
    case 'desktop': {
      const [cmd, a] = pwsh(path.join('scripts', 'smoke-staff-desktop.ps1'));
      return captureRun(stage, cmd, a);
    }
    case 'ui-admin': {
      return captureRun(stage, process.execPath, [path.join('scripts', 'qa-playwright.mjs')]);
    }
    case 'ui-mobile': {
      return captureRun(stage, process.execPath, [path.join('scripts', 'qa-maestro.mjs')], {
        timeoutMs: 30 * 60 * 1000, // mobile flows can take longer
      });
    }
    default:
      throw new Error(`unknown stage: ${stage}`);
  }
}

async function main() {
  const t0 = Date.now();
  log(`run_dir=${path.relative(repoRoot, runDir)}`);

  // Resolve stages.
  let stages = args.stages || [...DEFAULT_STAGES];
  if (args.skipReset) stages = stages.filter((s) => s !== 'reset');
  if (args.includeRole && !stages.includes('role')) stages.push('role');
  if (args.includeDesktop && !stages.includes('desktop')) stages.push('desktop');
  if (args.includeUiAdmin && !stages.includes('ui-admin')) stages.push('ui-admin');
  if (args.includeUiMobile && !stages.includes('ui-mobile')) stages.push('ui-mobile');

  // Service probes (skipped for stages that don't need them).
  const needsBackend = stages.some((s) =>
    ['admin', 'patient', 'staff', 'clinical', 'role'].includes(s)
  );
  const needsAdmin = stages.includes('admin');

  const probes = [];
  if (needsBackend) {
    const ok = await probe(BACKEND_HEALTH);
    probes.push({ target: BACKEND_HEALTH, ok });
    if (!ok) {
      log(`FAIL: backend not reachable at ${BACKEND_HEALTH}`);
      log('start it with: VH_LOCAL_SMOKE_PORT=5206 npm --prefix apps/backend run dev');
    }
  }
  if (needsAdmin) {
    const ok = await probe(ADMIN_PROBE);
    probes.push({ target: ADMIN_PROBE, ok });
    if (!ok) {
      log(`FAIL: admin proxy not reachable at ${ADMIN_PROBE}`);
      log('start it with: PORT=3201 npm --prefix apps/admin run dev');
    }
  }

  if (probes.some((p) => !p.ok)) {
    writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify(
        { run_id: runId, status: 'aborted', reason: 'service probes failed', probes },
        null,
        2
      )
    );
    process.exit(3);
  }

  // Run stages sequentially.
  const stageReports = [];
  for (const stage of stages) {
    const report = stageReports.length === 0 ? runStage(stage) : runStage(stage);
    stageReports.push(report);
    if (stage === 'reset' && report.exit_code !== 0) {
      log('reset failed — aborting subsequent stages');
      break;
    }
  }

  // Build summary.
  const seedMeta = await readSeedMeta();
  const summary = {
    run_id: runId,
    started_at: new Date(t0).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    git_sha: gitSha(),
    base_url_backend: BACKEND_HEALTH.replace(/\/api\/v1\/health$/, ''),
    base_url_admin: ADMIN_PROBE.replace(/\/api\/proxy\/api\/v1\/health$/, ''),
    seed_version: seedMeta?.seed_version || null,
    seeded_at: seedMeta?.seeded_at || null,
    seed_git_sha: seedMeta?.git_sha || null,
    stages: stageReports.map((s) => ({
      stage: s.stage,
      exit_code: s.exit_code,
      passed: s.exit_code === 0,
      started_at: s.started_at,
      finished_at: s.finished_at,
      timed_out: s.timed_out,
    })),
    overall_passed: stageReports.every((s) => s.exit_code === 0),
    probes,
  };
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  log(
    `done in ${(summary.duration_ms / 1000).toFixed(1)}s — ` +
      `passed=${summary.overall_passed} stages=${stageReports.length}`
  );
  log(`artifacts: ${path.relative(repoRoot, runDir)}`);
  process.exit(summary.overall_passed ? 0 : 1);
}

main().catch((err) => {
  console.error('[qa-orchestrator] crashed:', err);
  process.exit(1);
});
