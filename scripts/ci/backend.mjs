import { resolve } from 'node:path';
import { repoRoot, run } from './lib.mjs';

// Backend-only CI env. These belong to the backend stage ONLY — `prisma
// generate` (npm ci postinstall + db:generate) needs DATABASE_URL, and the app
// boot in `openapi:check` needs the validateEnv secrets. They must NOT be set
// job-wide: the admin stage's middleware.test.ts asserts the no-JWT_SECRET code
// path (the middleware reads JWT_SECRET at import, before the test can delete
// it), so a leaked JWT_SECRET makes it fail closed. CI-only dummies, all in the
// .gitleaks.toml allowlist (postgres:postgres@ DSN form, test-* values). The
// DATABASE_URL is a placeholder for the early steps; ci:backend:docker overrides
// it with its disposable container for the actual tests.
const backendEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/vhhealth',
  API_KEY: 'test-api-key',
  JWT_SECRET: 'test-jwt-secret-for-ci-must-be-at-least-32-chars',
  NODE_OPTIONS: '--max-old-space-size=4096',
  NODE_ENV: 'test',
  VH_ALLOW_NON_TEST_DATA_SEED: 'true',
  FIELD_ENCRYPTION_KEY: 'ci-field-encryption-key-32-chars-minimum',
  TOTP_ENCRYPTION_KEY: 'ci-totp-encryption-key-32-chars-minimum',
  BACKUP_ENCRYPTION_KEY: 'ci-backup-encryption-key-32-chars-minimum',
};

export function runBackendStage({ install = false } = {}) {
  const cwd = resolve(repoRoot, 'apps/backend');
  if (install) {
    run('npm', ['ci'], { cwd, env: backendEnv });
  }

  run('docker', ['version', '--format', '{{.Server.Version}}']);
  run('npm', ['run', 'ci'], { cwd, env: backendEnv });
}
