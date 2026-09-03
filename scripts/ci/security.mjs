import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { cacheDir, checkCommand, repoRoot, run } from './lib.mjs';

const gitleaksVersion = '8.30.1';

function gitleaksArchiveName() {
  if (process.platform === 'win32') {
    const arch = process.arch === 'x64' ? 'x64' : process.arch;
    return `gitleaks_${gitleaksVersion}_windows_${arch}.zip`;
  }
  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  return `gitleaks_${gitleaksVersion}_${platform}_${arch}.tar.gz`;
}

function downloadFile(url, targetPath) {
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  try {
    run('curl', [
      '--fail',
      '--location',
      '--retry',
      '5',
      '--retry-all-errors',
      '--connect-timeout',
      '30',
      '--output',
      tmpPath,
      url,
    ]);
    renameSync(tmpPath, targetPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

async function ensureGitleaks() {
  if (process.env.GITLEAKS_BIN || checkCommand('gitleaks', ['version'])) {
    return {};
  }

  if (process.platform === 'win32' && existsSync('D:\\Dev\\Tools\\gitleaks\\gitleaks.exe')) {
    return { GITLEAKS_BIN: 'D:\\Dev\\Tools\\gitleaks\\gitleaks.exe' };
  }

  const archive = gitleaksArchiveName();
  const toolCacheDir =
    process.env.GITLEAKS_CACHE_DIR ||
    cacheDir('gitleaks') ||
    join(homedir(), '.cache', 'vh-ci', 'gitleaks');
  const versionCacheDir = join(toolCacheDir, gitleaksVersion);
  const binPath = join(versionCacheDir, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
  if (existsSync(binPath)) {
    return { GITLEAKS_BIN: binPath };
  }

  mkdirSync(versionCacheDir, { recursive: true });
  const releaseBase = `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}`;
  const archivePath = join(versionCacheDir, archive);
  const checksumsPath = join(versionCacheDir, `gitleaks_${gitleaksVersion}_checksums.txt`);

  console.log(`Installing gitleaks ${gitleaksVersion} to ${versionCacheDir}`);
  downloadFile(`${releaseBase}/${archive}`, archivePath);
  downloadFile(`${releaseBase}/gitleaks_${gitleaksVersion}_checksums.txt`, checksumsPath);

  const expectedLine = readFileSync(checksumsPath, 'utf8')
    .split(/\r?\n/)
    .find((line) => line.endsWith(`  ${archive}`) || line.endsWith(` *${archive}`));
  if (!expectedLine) {
    throw new Error(`No checksum found for ${archive}`);
  }

  const expected = expectedLine.split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${basename(archivePath)}`);
  }

  run(
    'tar',
    [
      process.platform === 'win32' ? '-xf' : '-xzf',
      archivePath,
      '-C',
      versionCacheDir,
      process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks',
    ],
  );
  if (process.platform !== 'win32') {
    run('chmod', ['0755', binPath]);
  }

  return { GITLEAKS_BIN: binPath };
}

/**
 * Run semgrep with the focused VH Health config (.semgrep.yml).
 * Returns true if semgrep ran successfully, false if semgrep is not installed
 * (the caller skips gracefully so dev machines without semgrep are not broken).
 * Findings are written to output/security/semgrep-focused.sarif.
 *
 * WS3 B3.4 (2026-06-13): semgrep is now BLOCKING on CI. Any finding causes
 * the security stage to fail. If semgrep is not installed the stage skips
 * gracefully — install semgrep to get full coverage:
 *   pip install semgrep
 */
function isCiEnvironment(env) {
  return (
    env.GITHUB_ACTIONS === 'true' ||
    env.FORGEJO_ACTIONS === 'true' ||
    /^(1|true)$/i.test(env.CI || '')
  );
}

export function requireSemgrepAvailability(
  available,
  { env = process.env, log = console.log } = {},
) {
  if (available) return true;
  if (isCiEnvironment(env)) {
    throw new Error('Semgrep is required in CI but was not found on PATH');
  }
  log(
    'semgrep not found — skipping focused SAST scan (not installed).\n' +
      'Install with: pip install semgrep\n' +
      'Then run: semgrep scan --config .semgrep.yml --sarif --output output/security/semgrep-focused.sarif',
  );
  return false;
}

function runSemgrepFocused() {
  // Discover semgrep: prefer a venv the CI workflow may have installed,
  // then fall back to PATH.
  const candidates = [
    '/tmp/vh-semgrep-venv/bin/semgrep',
    'semgrep',
  ];
  const semgrepBin = candidates.find((bin) => checkCommand(bin, ['--version']));
  if (!semgrepBin) {
    return requireSemgrepAvailability(false);
  }

  mkdirSync(join(repoRoot, 'output', 'security'), { recursive: true });

  // Build the exclusion list that matches the .semgrep.yml documentation.
  const excludeDirs = [
    'apps/backend/node_modules',
    'apps/admin/node_modules',
    'infra/mcp',
    'infra/onprem',
    'apps/admin/.next',
    'output',
    'build',
    'apps/backend/src/logs',
    'apps/patient/build',
    'apps/staff/build',
    'tmp',
  ];

  const args = [
    'scan',
    '--config', '.semgrep.yml',
    '--error',
    '--severity', 'ERROR',
    '--sarif',
    '--output', 'output/security/semgrep-focused.sarif',
    '--timeout', '300',
    '--jobs', '4',
    ...excludeDirs.flatMap((d) => ['--exclude', d]),
  ];

  // WS3 B3.4: errors propagate — any semgrep finding fails the stage.
  run(semgrepBin, args, {
    env: {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  });
  console.log('Semgrep focused scan complete. Results: output/security/semgrep-focused.sarif');
  return true;
}

export async function runSecurityStage() {
  const gitleaksEnv = await ensureGitleaks();
  run('git', ['diff', '--check']);

  // Applied-migration immutability. Deliberately in THIS stage rather than the
  // backend one: `security` is the only stage selected by every canonical plan,
  // and a guard whose purpose is to stop unvalidated changes reaching a live
  // database must not itself be skippable by tier routing. It is also a
  // git-history check like the range secret scan below, not a source lint, so
  // it belongs with them. Costs one `git diff --raw` over one directory.
  run(process.execPath, ['scripts/ci/check-migration-immutability.mjs']);

  // Session-scoped GUC leaks in migrations. Same stage and same reasoning as the
  // immutability gate above: a guard that exists to keep body validation ON for
  // every migration must not be skippable by tier routing. A bare
  // `SET check_function_bodies = false` outlives its own file because every
  // migration is applied through one connection — which is how 744 and 745
  // shipped plpgsql bodies that cannot compile while CI stayed green.
  run(process.execPath, ['scripts/ci/check-migration-session-guc.mjs']);

  // Dead-code retirement is a repository-wide invariant, not an Admin or
  // Flutter quality signal. Keep both its mutation proof and live manifest in
  // the one stage selected by every canonical plan so a path filter cannot
  // silently resurrect an audited surface.
  run(process.execPath, ['--test', 'scripts/ci/check-dead-code-retirements.test.mjs']);
  run(process.execPath, ['scripts/ci/check-dead-code-retirements.mjs']);

  // Inline CHECK census (OPEN-23): an inline CHECK inside a `CREATE TABLE IF
  // NOT EXISTS` re-declaration of a baseline-owned table never reaches the
  // database. The static half — the pinned census and its regression guard —
  // needs no database and lives here, in the one stage every canonical plan
  // selects, with its mutation proof beside it. The pg_constraint calibration
  // runs in the DB-backed backend job (`--verify-db`) next to the schema drift
  // check; the meta-test fails CI if either wiring line is removed.
  run(process.execPath, ['--test', 'scripts/ci/check-inline-check-census.test.mjs']);
  run(process.execPath, ['scripts/ci/check-inline-check-census.mjs']);

  run(process.execPath, ['scripts/check-forgejo-supply-chain-pins.mjs']);
  run(process.execPath, ['scripts/scan-secrets.mjs']);
  run(process.execPath, ['scripts/gitleaks-scan.mjs', 'worktree'], { env: gitleaksEnv });
  run(process.execPath, ['scripts/gitleaks-scan.mjs', 'range'], { env: gitleaksEnv });
  run(process.execPath, ['scripts/security/check-infra-security-controls.mjs']);

  // WS3 B3.4 (2026-06-13): SAST scan with focused VH Health ruleset.
  // Now BLOCKING — any semgrep finding throws and fails this stage.
  // On dev machines without semgrep installed, the call skips gracefully.
  // The GHA workflow installs semgrep unconditionally (pip install semgrep)
  // so findings never pass silently on CI.
  runSemgrepFocused();
}
