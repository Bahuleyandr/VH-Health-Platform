import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { changedFilesForBranchPush } from './stage-selection.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('branch-push selection covers the complete branch delta, not only the latest push', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vh-stage-selection-'));
  const priorCwd = process.cwd();
  const priorEventPath = process.env.GITHUB_EVENT_PATH;
  t.after(() => {
    process.chdir(priorCwd);
    if (priorEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = priorEventPath;
    rmSync(root, { recursive: true, force: true });
  });

  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'ci-test@vhhealth.app']);
  git(root, ['config', 'user.name', 'VH Health CI test']);
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  const main = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/remotes/origin/main', main]);

  git(root, ['switch', '-c', 'feature']);
  mkdirSync(join(root, 'apps', 'backend', 'src'), { recursive: true });
  writeFileSync(join(root, 'apps', 'backend', 'src', 'gate-fixture.js'), 'export const value = 1;\n');
  git(root, ['add', 'apps/backend/src/gate-fixture.js']);
  git(root, ['commit', '-m', 'backend change']);
  const previousPush = git(root, ['rev-parse', 'HEAD']);

  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'gate-fixture.md'), 'trailing docs update\n');
  git(root, ['add', 'docs/gate-fixture.md']);
  git(root, ['commit', '-m', 'trailing docs change']);

  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ before: previousPush }));
  process.env.GITHUB_EVENT_PATH = eventPath;
  process.chdir(root);

  assert.deepEqual(changedFilesForBranchPush().sort(), [
    'apps/backend/src/gate-fixture.js',
    'docs/gate-fixture.md',
  ]);
});
