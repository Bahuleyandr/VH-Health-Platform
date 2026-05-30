import { resolve } from 'node:path';
import { ciEnv, repoRoot, run } from './lib.mjs';

export function runAdminStage({ install = false } = {}) {
  const cwd = resolve(repoRoot, 'apps/admin');
  if (install) {
    run('npm', ['ci'], { cwd, env: ciEnv });
  }

  run('npm', ['audit', '--audit-level=high'], { cwd, env: ciEnv });
  run('npm', ['run', 'lint'], { cwd, env: ciEnv });
  run('npm', ['run', 'type-check'], { cwd, env: ciEnv });
  run('npm', ['test'], { cwd, env: ciEnv });
  run('npm', ['run', 'build'], { cwd, env: ciEnv });
  run('npm', ['run', 'check:clinical-ai-bundle'], { cwd, env: ciEnv });
}

