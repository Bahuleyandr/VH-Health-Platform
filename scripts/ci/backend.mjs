import { resolve } from 'node:path';
import { repoRoot, run } from './lib.mjs';

export function runBackendStage({ install = false } = {}) {
  const cwd = resolve(repoRoot, 'apps/backend');
  if (install) {
    run('npm', ['ci'], { cwd });
  }

  run('docker', ['version', '--format', '{{.Server.Version}}']);
  run('npm', ['run', 'ci'], { cwd });
}

