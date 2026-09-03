import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, '../../..');
const src = path.join(backend, 'src');
const read = (relativePath) => fs.readFileSync(path.join(src, relativePath), 'utf8');
const visitFiles = (target, files = []) => {
  if (!fs.existsSync(target)) return files;
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    files.push(target);
    return files;
  }
  for (const entry of fs.readdirSync(target)) visitFiles(path.join(target, entry), files);
  return files;
};

describe('auth revocation protocol structural guards', () => {
  it.each([
    ['services/auth/userActiveSession.js', 1],
    ['services/auth/staffAuthService.js', 1],
    ['services/auth/authService.js', 2],
    ['services/sessionManagementService.js', 1],
  ])('%s requires durable evidence at every blacklistToken caller', (relativePath, expectedCalls) => {
    const source = read(relativePath);
    const calls = source.match(/\bblacklistToken\s*\(/g) ?? [];
    const durableCalls = source.match(
      /\bblacklistToken\s*\([\s\S]{0,600}?requireEvidence:\s*true[\s\S]{0,300}?\);/g,
    ) ?? [];
    expect(calls).toHaveLength(expectedCalls);
    expect(durableCalls).toHaveLength(expectedCalls);
  });

  it('fails when a new production blacklistToken caller bypasses the durable-evidence census', () => {
    const productionFiles = visitFiles(src)
      .filter((file) => file.endsWith('.js'))
      .filter((file) => !file.includes(`${path.sep}tests${path.sep}`))
      .filter((file) => file !== path.join(src, 'utils/tokenBlacklist.js'));
    const callers = productionFiles
      .filter((file) => /\bblacklistToken\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(src, file).replaceAll(path.sep, '/'))
      .sort();
    expect(callers).toEqual([
      'services/auth/authService.js',
      'services/auth/staffAuthService.js',
      'services/auth/userActiveSession.js',
      'services/sessionManagementService.js',
    ]);
  });

  it('keeps the legacy create-admin entry point as a direct-execution tombstone', () => {
    const scriptPath = path.join(src, 'scripts/create-admin.js');
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: 'postgresql://must-not-connect.invalid/vhhealth',
        ADMIN_BOOTSTRAP_PASSWORD: path.basename(scriptPath),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/create-admin\.js is retired/);
    expect(result.stdout).toBe('');
    expect(read('scripts/create-admin.js')).not.toMatch(/bcrypt|pg|prisma|CREATE TABLE|INSERT|UPDATE/);
  });

  it('has no production caller for the retired create-admin script', () => {
    const productionRoots = [
      path.join(backend, 'package.json'),
      path.join(backend, 'scripts'),
      path.join(src, 'bin'),
      path.join(src, 'config'),
      path.join(src, 'controllers'),
      path.join(src, 'routes'),
      path.join(src, 'scheduler'),
      path.join(src, 'services'),
      path.join(src, 'utils'),
    ];
    const files = productionRoots.flatMap((root) => visitFiles(root));
    const callers = files.filter((file) => (
      file !== path.join(src, 'scripts/create-admin.js')
      && fs.readFileSync(file, 'utf8').includes('create-admin.js')
    ));
    expect(callers).toEqual([]);
  });
});
