import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

test('retired provider workflows, publishers and mirror detector cannot execute', () => {
  const workflows = resolve(root, '.forgejo/workflows');
  assert.deepEqual(existsSync(workflows) ? readdirSync(workflows) : [], []);
  for (const path of [
    '.github/workflows/forgejo-mirror-liveness.yml',
    'scripts/ci/forgejo-release-assets.mjs',
    'scripts/ci/forgejo-buildkit-builder.mjs',
    'scripts/ci/forgejo-deploy-preflight.mjs',
    'scripts/ci/forgejo-liveness.mjs',
  ]) assert.equal(existsSync(resolve(root, path)), false, path);
  assert.match(read('scripts/ci/security.mjs'), /check-workflow-supply-chain-pins\.mjs/);
  assert.doesNotMatch(read('scripts/ci/infra.mjs'), /forgejo-(?:liveness|deploy-preflight|buildkit)/);
});

test('hosted smoke remains manual and requires the shared preflight before probes', () => {
  for (const name of ['post-deploy-smoke', 'trial-readiness-smoke']) {
    const workflow = read('.github/workflows/' + name + '.yml');
    const trigger = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
    assert.match(trigger, /workflow_dispatch:/);
    assert.doesNotMatch(trigger, /\b(?:push|pull_request|schedule|workflow_run|workflow_call):/);
    assert.match(workflow, /VH_SMOKE_AUTHORIZED_BY:/);
    assert.match(workflow, /VH_SMOKE_AUTHORITY_REF:/);
    assert.match(workflow, /VH_SMOKE_EXPECTED_COMMIT:/);
    assert.match(workflow, /manual-smoke-preflight\.mjs --mode/);
    const preflight = workflow.indexOf('manual-smoke-preflight.mjs --mode');
    const runner = workflow.indexOf(name === 'post-deploy-smoke'
      ? 'node scripts/ci/post-deploy-smoke.mjs' : './scripts/smoke-staff-role-workflows.ps1');
    assert.ok(runner > preflight, name + ' must validate before its probe runner');
  }
});

test('container validation never publishes images or receives signing/deployment credentials', () => {
  const workflow = read('.github/workflows/container-supply-chain.yml');
  assert.match(workflow, /push: false/);
  assert.match(workflow, /load: true/);
  assert.match(workflow, /--scanners vuln,secret/);
  assert.match(workflow, /--exit-code 1/);
  assert.doesNotMatch(workflow, /secrets\.|docker\/login-action|cosign sign|docker push|git push/);
  assert.match(workflow, /Generate SBOM\n\s+continue-on-error: true/);
});

test('canonical gate waits for the blocking repository and selected container checks', () => {
  const workflow = read('.github/workflows/ci.yml');
  const aggregate = workflow.slice(workflow.indexOf('\n  merge_gate:'));
  assert.match(aggregate, /- security_sweep/);
  assert.match(aggregate, /- container_validation/);
  assert.match(aggregate, /test "\$SECURITY_SWEEP_RESULT" = success/);
  assert.match(aggregate, /test "\$CONTAINER_RESULT" = success/);
  for (const name of ['security-sweep', 'container-supply-chain']) {
    assert.doesNotMatch(read('.github/workflows/' + name + '.yml'), /cancel-in-progress: true/);
  }
});

test('every canonical tier keeps both blocking npm dependency audits', () => {
  const workflow = read('.github/workflows/ci.yml');
  const sweepJob = workflow.slice(workflow.indexOf('\n  security_sweep:'), workflow.indexOf('\n  container_validation:'));
  assert.match(sweepJob, /if: \$\{\{ always\(\) && needs\.plan\.result == 'success' \}\}/);
  assert.doesNotMatch(sweepJob, /outputs\.(?:tier|backend|admin)/);
  const sweep = read('.github/workflows/security-sweep.yml');
  for (const app of ['backend', 'admin']) {
    const auditStep = sweep.split(/\n      - /).find((step) => step.includes('name: npm audit ' + app));
    assert.ok(auditStep, app + ' audit is present');
    assert.match(auditStep, new RegExp('npm --prefix apps/' + app + ' audit --audit-level=high'));
    assert.doesNotMatch(auditStep, /continue-on-error|--omit=dev|\|\| true/);
  }
});

test('active retirement and immutable-pin documentation exists', () => {
  for (const path of ['docs/FORGEJO_RETIREMENT.md', 'docs/WORKFLOW_SUPPLY_CHAIN_PINS.md']) {
    assert.ok(existsSync(resolve(root, path)), path);
    assert.ok(read(path).length > 500, path + ' is not an empty placeholder');
  }
  assert.match(read('infra/forgejo/SUPPLY_CHAIN_PINS.md'), /historical/i);
  assert.doesNotMatch(read('infra/forgejo/SUPPLY_CHAIN_PINS.md'), /node scripts\/check-forgejo-supply-chain-pins\.mjs/);
});

test('retirement preserves the historical public key without authorizing its signer', () => {
  const key = read('infra/forgejo/signing/cosign.pub');
  assert.match(key, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n$/);
  const policy = read('infra/kubernetes/base/image-policy/kyverno-verify-images.yaml');
  assert.match(policy, /validationFailureAction: Audit/);
  assert.match(policy, /failurePolicy: Fail/);
  assert.match(policy, /issuer: "https:\/\/token\.actions\.githubusercontent\.com"/);
  assert.match(policy, /release-images\|deploy-dalekdefender/);
  assert.doesNotMatch(policy, /^\s*(?:-\s*)?keys:/m);
  assert.doesNotMatch(policy, /vhhealth-cosign-public-key/);
  assert.match(policy, /verifyDigest: true/);
  assert.match(policy, /required: true/);
});
