import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { checkCommand, run } from './lib.mjs';

const gitleaksVersion = '8.30.1';

function gitleaksArchiveName() {
  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  return `gitleaks_${gitleaksVersion}_${platform}_${arch}.tar.gz`;
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(targetPath));
}

async function ensureGitleaks() {
  if (process.env.GITLEAKS_BIN || checkCommand('gitleaks', ['version'])) {
    return {};
  }

  if (process.platform === 'win32' && existsSync('D:\\Dev\\Tools\\gitleaks\\gitleaks.exe')) {
    return { GITLEAKS_BIN: 'D:\\Dev\\Tools\\gitleaks\\gitleaks.exe' };
  }

  const archive = gitleaksArchiveName();
  const cacheDir = join(homedir(), '.cache', 'vh-ci', 'gitleaks', gitleaksVersion);
  const binPath = join(cacheDir, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
  if (existsSync(binPath)) {
    return { GITLEAKS_BIN: binPath };
  }

  mkdirSync(cacheDir, { recursive: true });
  const releaseBase = `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaksVersion}`;
  const archivePath = join(cacheDir, archive);
  const checksumsPath = join(cacheDir, `gitleaks_${gitleaksVersion}_checksums.txt`);

  console.log(`Installing gitleaks ${gitleaksVersion} to ${cacheDir}`);
  await downloadFile(`${releaseBase}/${archive}`, archivePath);
  await downloadFile(`${releaseBase}/gitleaks_${gitleaksVersion}_checksums.txt`, checksumsPath);

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

  run('tar', ['-xzf', archivePath, '-C', cacheDir, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks']);
  if (process.platform !== 'win32') {
    run('chmod', ['0755', binPath]);
  }

  return { GITLEAKS_BIN: binPath };
}

export async function runSecurityStage() {
  const gitleaksEnv = await ensureGitleaks();
  run('git', ['diff', '--check']);
  run(process.execPath, ['scripts/scan-secrets.mjs']);
  run(process.execPath, ['scripts/gitleaks-scan.mjs', 'worktree'], { env: gitleaksEnv });
  run(process.execPath, ['scripts/gitleaks-scan.mjs', 'range'], { env: gitleaksEnv });
}
