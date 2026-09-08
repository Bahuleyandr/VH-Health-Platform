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
  // onnxruntime-node's postinstall (script/install.js) downloads the CUDA 12
  // execution-provider .so files from api.nuget.org on linux/x64. No CI runner
  // has a GPU, the CPU runtime (libonnxruntime.so.1 + onnxruntime_binding.node)
  // is bundled in the npm tarball, and the only consumer
  // (apps/backend/src/services/gamification/adherenceModelServing.js) uses the
  // default CPU provider — so the download is dead weight that failed `npm ci`
  // with ETIMEDOUT to 150.171.109.77:443 on PR #1023. `skip` makes install.js
  // exit before any network call (parseInstallFlag in script/install-utils.js,
  // v1.27.0). This is the single seat for every `run.mjs --install` caller
  // (.forgejo/workflows/ci.yml, full-stack-sweep.yml, secret-scan.yml,
  // security-sweep.yml); the .github workflows never pass --install and carry
  // the same env on their own `npm ci` steps (PR #1045). Inert on `npm run ci`
  // below: only install.js reads it.
  ONNXRUNTIME_NODE_INSTALL: 'skip',
};

export function runBackendStage({ install = false } = {}) {
  const cwd = resolve(repoRoot, 'apps/backend');
  if (install) {
    run('npm', ['ci'], { cwd, env: backendEnv });
  }

  run('docker', ['version', '--format', '{{.Server.Version}}']);
  run('npm', ['run', 'ci'], { cwd, env: backendEnv });
}
