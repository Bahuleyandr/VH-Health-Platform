// Behaviour of the root-owned dalekdefender deploy helper, driven through a
// stubbed kubectl + curl. Covers the two rollout-failure scenarios it was
// written for, and the migration step that makes the rig's deploys survive a
// new migration without a human hand-running a Job.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bashPath = value => {
  const normalized = value.replaceAll('\\', '/');
  if (process.platform !== 'win32') return normalized;
  const match = normalized.match(/^([A-Za-z]):(\/.*)$/);
  return match ? `/mnt/${match[1].toLowerCase()}${match[2]}` : normalized;
};
const spawnBash = (args, options) => process.platform === 'win32'
  ? spawnSync('wsl.exe', ['-e', 'bash', ...args], options)
  : spawnSync('bash', args, options);
const helper = path.join(
  repoRoot,
  'infra/kubernetes/overlays/dalekdefender/vhhealth-gha-deploy.sh'
).replaceAll('\\', '/');

const PREV_BACKEND = 'ghcr.io/bahuleyandr/vh-health-platform-backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PREV_ADMIN = 'ghcr.io/bahuleyandr/vh-health-platform-adminportal@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PREV_COMMIT = '1111111111111111111111111111111111111111';
const NEW_BACKEND = 'ghcr.io/bahuleyandr/vh-health-platform-backend@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const NEW_ADMIN = 'ghcr.io/bahuleyandr/vh-health-platform-adminportal@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const NEW_COMMIT = '2222222222222222222222222222222222222222';

/**
 * A kubectl stub that always answers the "what is deployed now" reads and the
 * migration-Job lifecycle, and delegates the rollout-status answer to the
 * caller-supplied fragment.
 *
 * @param {object} options
 * @param {'complete'|'failed'} options.jobOutcome  Job condition to report.
 * @param {number|null} options.migrationsApplied   Count in the Job's log
 *   summary; null omits the summary line entirely (the "unknown" path).
 * @param {string} options.rolloutStatus            bash fragment handling
 *   `rollout status` calls.
 */
function kubectlStub({ jobOutcome = 'complete', migrationsApplied = 0, rolloutStatus = 'exit 0' }) {
  // Production NODE_ENV means pino JSON — the helper's grep must survive it.
  const summaryLine = migrationsApplied === null
    ? 'true'
    : String.raw`printf '{"level":30,"msg":"→ Migrations: ${migrationsApplied} applied, 731 already-tracked, 0 skipped (known-bad), 0 errors"}\n'`;
  const completeAnswer = jobOutcome === 'complete' ? "printf 'True'" : 'true';
  const failedAnswer = jobOutcome === 'failed' ? "printf 'True'" : 'true';

  return String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_KUBECTL_STATE/calls.log"

# The helper pipes the rendered manifest in; a kubectl that never reads stdin
# would SIGPIPE the writer and, under pipefail, look like an apply failure.
if [[ "$*" == *"apply -f -"* ]]; then
  cat > "$FAKE_KUBECTL_STATE/applied-manifest.yaml"
  exit 0
fi
if [[ "$*" == *"delete job"* ]]; then
  exit 0
fi
if [[ "$*" == *'@.type=="Complete"'* ]]; then
  ${completeAnswer}
  exit 0
fi
if [[ "$*" == *'@.type=="Failed"'* ]]; then
  ${failedAnswer}
  exit 0
fi
if [[ "$*" == *"logs job/vhhealth-backend-migrate"* ]]; then
  ${summaryLine}
  exit 0
fi

if [[ "$*" == *"get deploy/vhhealth-backend"*"jsonpath={.spec.template.spec.containers[0].image}"* ]]; then
  printf '%s' '${PREV_BACKEND}'
  exit 0
fi
if [[ "$*" == *"get deploy/vhhealth-admin"*"jsonpath={.spec.template.spec.containers[0].image}"* ]]; then
  printf '%s' '${PREV_ADMIN}'
  exit 0
fi
if [[ "$*" == *"get deploy/vhhealth-backend"*"GIT_COMMIT"* ]]; then
  printf '%s' '${PREV_COMMIT}'
  exit 0
fi
${rolloutStatus}
exit 0
`;
}

const CURL_ALWAYS = commit => String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "$FAKE_KUBECTL_STATE/calls.log"
printf '%s' '{"status":"ok","commit":"${commit}"}'
`;

function runHelper(t, { kubectl, curl, prefix = 'vhhealth-gha-deploy-' }) {
  const stateDir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const fakeKubectl = path.join(stateDir, 'kubectl');
  writeFileSync(fakeKubectl, kubectl, { mode: 0o755 });
  chmodSync(fakeKubectl, 0o755);

  const fakeCurl = path.join(stateDir, 'curl');
  writeFileSync(fakeCurl, curl, { mode: 0o755 });
  chmodSync(fakeCurl, 0o755);

  const result = spawnBash([
    '-c',
    'KUBECTL="$1" FAKE_KUBECTL_STATE="$2" CURL="$3"'
      + ' VH_DEPLOY_MIGRATE_POLL_INTERVAL=0 VH_DEPLOY_MIGRATE_TIMEOUT=60 "$4"',
    'vhhealth-deploy-test',
    bashPath(fakeKubectl),
    bashPath(stateDir),
    bashPath(fakeCurl),
    bashPath(helper),
  ], {
    encoding: 'utf8',
    env: process.env,
    input: [NEW_BACKEND, NEW_ADMIN, NEW_COMMIT, ''].join('\n'),
  });

  const readCalls = () => readFileSync(path.join(stateDir, 'calls.log'), 'utf8');
  const readManifest = () => readFileSync(path.join(stateDir, 'applied-manifest.yaml'), 'utf8');
  return { result, stateDir, readCalls, readManifest };
}

test('a backend rollout failure cannot be masked by a successful admin rollout', t => {
  const { result, readCalls } = runHelper(t, {
    // Nothing pending, so the automatic rollback is still safe.
    kubectl: kubectlStub({
      migrationsApplied: 0,
      rolloutStatus: String.raw`
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
fi`,
    }),
    // This scenario never reaches the deploy-side verify (the backend rollout
    // fails first); the rollback-side verify must see the restored commit.
    curl: CURL_ALWAYS(PREV_COMMIT),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /Rollback succeeded/);

  const calls = readCalls();
  assert.match(calls, /rollout status deploy\/vhhealth-backend/);
  assert.match(calls, /rollout status deploy\/vhhealth-admin/);
  assert.match(calls, /backend=.*sha256:aaaaaaaa/);
  assert.match(calls, /admin=.*sha256:bbbbbbbb/);
  assert.match(calls, /NODE_OPTIONS=--max-old-space-size=768/);
  assert.match(calls, /TENANT_BASE_HOST=vhhealth\.app/);
});

test('a rollout with the wrong live commit fails and restores the previous deployment', t => {
  const { result } = runHelper(t, {
    kubectl: kubectlStub({ migrationsApplied: 0 }),
    // Version scenarios live on the curl stub (the helper verifies via the
    // localhost bridge with X-Forwarded-Proto, not the kubectl service proxy):
    // first verify sees the WRONG commit (deploy-side failure under test),
    // every later verify sees the restored one (rollback-side success).
    curl: String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >> "$FAKE_KUBECTL_STATE/calls.log"
count_file="$FAKE_KUBECTL_STATE/version-count"
count=0
[[ -f "$count_file" ]] && count="$(cat "$count_file")"
count=$((count + 1))
printf '%s' "$count" > "$count_file"
if [[ "$count" -eq 1 ]]; then
  printf '%s' '{"status":"ok","commit":"3333333333333333333333333333333333333333"}'
else
  printf '%s' '{"status":"ok","commit":"${PREV_COMMIT}"}'
fi
`,
    prefix: 'vhhealth-gha-deploy-version-',
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /deployed commit 3333333333333333333333333333333333333333 does not match requested commit/);
  assert.match(result.stdout, /Rollback succeeded/);
  assert.match(result.stdout, new RegExp(`Verified /health/version commit ${PREV_COMMIT}`));
});

// ── Migration step ─────────────────────────────────────────────────────────

test('migrations run before the images are pinned, against the digest being deployed', t => {
  const { result, readCalls, readManifest } = runHelper(t, {
    kubectl: kubectlStub({ migrationsApplied: 1 }),
    curl: CURL_ALWAYS(NEW_COMMIT),
    prefix: 'vhhealth-gha-deploy-migrate-ok-',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Deploy complete/);
  assert.match(result.stdout, /Migration Job vhhealth-backend-migrate complete \(1 migration\(s\) applied\)/);

  const calls = readCalls();
  const applyIndex = calls.indexOf('apply -f -');
  const setImageIndex = calls.indexOf('set image deploy/vhhealth-backend');
  assert.notEqual(applyIndex, -1, 'the migration Job was never applied');
  assert.notEqual(setImageIndex, -1, 'the backend image was never pinned');
  assert.ok(
    applyIndex < setImageIndex,
    'the migration Job must be applied before the deployment images are pinned',
  );
  // The previous run's pods share the job-name label, so a stale Job would
  // make the log read (and therefore the applied-count) belong to another run.
  assert.match(calls, /delete job vhhealth-backend-migrate .*--cascade=foreground/);

  // The Job must carry the exact digest this deploy verified — not a floating
  // tag, and not the leftover placeholder.
  const manifest = readManifest();
  assert.match(manifest, new RegExp(`image: ${NEW_BACKEND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.doesNotMatch(manifest, /0\.0\.0-placeholder/);
  assert.match(manifest, /kind: Job/);
});

test('a failing migration aborts the deploy with the previous images still pinned', t => {
  const { result, readCalls } = runHelper(t, {
    kubectl: kubectlStub({ jobOutcome: 'failed' }),
    curl: CURL_ALWAYS(NEW_COMMIT),
    prefix: 'vhhealth-gha-deploy-migrate-fail-',
  });

  assert.notEqual(result.status, 0, 'a failed migration must fail the deploy');
  assert.match(result.stderr, /Migration Job vhhealth-backend-migrate FAILED/);
  assert.match(result.stderr, /deployment images were left untouched/);

  const calls = readCalls();
  assert.doesNotMatch(
    calls, /set image/,
    'no deployment image may be changed once migrations have failed — API workers must not '
    + 'start against a schema the migration step could not produce',
  );
  assert.doesNotMatch(calls, /rollout status/);
  // Diagnostics, so the operator can see which migration failed.
  assert.match(calls, /describe job vhhealth-backend-migrate/);
});

test('a rollout failure after migrations applied refuses to roll the image back', t => {
  const { result, readCalls } = runHelper(t, {
    kubectl: kubectlStub({
      migrationsApplied: 3,
      rolloutStatus: String.raw`
if [[ "$*" == *"rollout status deploy/vhhealth-backend"* ]]; then
  exit 1
fi`,
    }),
    curl: CURL_ALWAYS(NEW_COMMIT),
    prefix: 'vhhealth-gha-deploy-no-rollback-',
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Refusing automatic rollback: this deploy applied 3 migration\(s\)/);
  assert.match(result.stderr, /MIGRATION_TIP_MISMATCH/);

  const calls = readCalls();
  const restores = calls.match(/set image deploy\/vhhealth-backend backend=.*sha256:aaaaaaaa/g) ?? [];
  assert.equal(
    restores.length, 0,
    'restoring the previous image over a migrated database would replace a broken pod with '
    + 'one that cannot boot at all',
  );
  assert.doesNotMatch(result.stdout, /Rolling back/);
});

test('an unreadable applied-count is treated as "migrations may have run"', t => {
  const { result } = runHelper(t, {
    // No summary line in the Job log at all.
    kubectl: kubectlStub({
      migrationsApplied: null,
      rolloutStatus: String.raw`
if [[ "$*" == *"rollout status deploy/vhhealth-backend"* ]]; then
  exit 1
fi`,
    }),
    curl: CURL_ALWAYS(NEW_COMMIT),
    prefix: 'vhhealth-gha-deploy-unknown-count-',
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Refusing automatic rollback: this deploy applied unknown migration\(s\)/);
});
