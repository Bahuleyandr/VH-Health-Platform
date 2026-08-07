import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(
  repoRoot,
  'infra/kubernetes/overlays/dalekdefender/vhhealth-gha-deploy.sh'
);

test('a backend rollout failure cannot be masked by a successful admin rollout', t => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'vhhealth-gha-deploy-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const fakeKubectl = path.join(stateDir, 'kubectl');
  writeFileSync(
    fakeKubectl,
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_KUBECTL_STATE/calls.log"

if [[ "$*" == *"get deploy/vhhealth-backend"*"jsonpath={.spec.template.spec.containers[0].image}"* ]]; then
  printf '%s' 'ghcr.io/bahuleyandr/vh-health-platform-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  exit 0
fi
if [[ "$*" == *"get deploy/vhhealth-admin"*"jsonpath={.spec.template.spec.containers[0].image}"* ]]; then
  printf '%s' 'ghcr.io/bahuleyandr/vh-health-platform-adminportal@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  exit 0
fi
if [[ "$*" == *"get deploy/vhhealth-backend"*"GIT_COMMIT"* ]]; then
  printf '%s' '1111111111111111111111111111111111111111'
  exit 0
fi
if [[ "$*" == *"rollout status deploy/vhhealth-backend"* ]]; then
  count_file="$FAKE_KUBECTL_STATE/backend-count"
  count=0
  [[ -f "$count_file" ]] && count="$(cat "$count_file")"
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  [[ "$count" -gt 1 ]]
  exit
fi
if [[ "$*" == *"rollout status deploy/vhhealth-admin"* ]]; then
  exit 0
fi
exit 0
`,
    { mode: 0o755 }
  );
  chmodSync(fakeKubectl, 0o755);

  const result = spawnSync('bash', [helper], {
    encoding: 'utf8',
    env: { ...process.env, KUBECTL: fakeKubectl, FAKE_KUBECTL_STATE: stateDir },
    input: [
      'ghcr.io/bahuleyandr/vh-health-platform-backend@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      'ghcr.io/bahuleyandr/vh-health-platform-adminportal@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      '2222222222222222222222222222222222222222',
      '',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Rollback succeeded/);

  const calls = readFileSync(path.join(stateDir, 'calls.log'), 'utf8');
  assert.match(calls, /rollout status deploy\/vhhealth-backend/);
  assert.match(calls, /rollout status deploy\/vhhealth-admin/);
  assert.match(calls, /backend=.*sha256:aaaaaaaa/);
  assert.match(calls, /admin=.*sha256:bbbbbbbb/);
});
