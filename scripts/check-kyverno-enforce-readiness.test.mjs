import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./check-kyverno-enforce-readiness.mjs', import.meta.url).href;
const policyName = 'verify-vhhealth-image-signatures';

function policy() {
  return { spec: {
    validationFailureAction: 'Audit', failurePolicy: 'Fail',
    rules: [{ verifyImages: [{
      required: true, verifyDigest: true, mutateDigest: true,
      attestors: [{ count: 1, entries: [{ keyless: {
        issuer: 'https://token.actions.githubusercontent.com',
        subjectRegExp: '^https://github\\.com/Bahuleyandr/VH-Health-Platform/\\.github/workflows/(release-images|deploy-dalekdefender)\\.yml@.*$',
        rekor: { url: 'https://rekor.sigstore.dev' },
      } }] }],
    }] }],
  } };
}

function run(livePolicy, results = [{ policy: policyName, result: 'pass', timestamp: new Date().toISOString() }]) {
  const harness = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const policy = ${JSON.stringify(livePolicy)};
    const results = ${JSON.stringify(results)};
    childProcess.spawnSync = (command, args) => {
      if (command !== 'kubectl' || args[0] !== 'get') throw new Error('Unexpected command');
      const response = args[1] === 'clusterpolicy' ? policy :
        args[1] === 'policyreport' ? { items: [{ results }] } : { items: [] };
      return { status: 0, stdout: JSON.stringify(response), stderr: '' };
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'check-kyverno-enforce-readiness.mjs', '--live'];
    await import(${JSON.stringify(script)});
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', harness], { encoding: 'utf8' });
}

test('GitHub-only live policy requires a populated clean Audit cycle', () => {
  const result = run(policy());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PolicyReport clean: 1 fresh pass/);
  for (const results of [[], [{ policy: policyName, result: 'fail' }]]) {
    assert.equal(run(policy(), results).status, 1);
  }
});

test('retired signers, weakened digest checks and unexpected identities fail closed', () => {
  const mutations = [
    (value) => value.spec.rules[0].verifyImages[0].attestors[0].entries.push({ keys: { publicKeys: 'retired-key' } }),
    (value) => { value.spec.rules[0].verifyImages[0].required = false; },
    (value) => { value.spec.rules[0].verifyImages[0].verifyDigest = false; },
    (value) => { value.spec.rules[0].verifyImages[0].attestors[0].entries[0].keyless.issuer = 'https://issuer.example.invalid'; },
    (value) => { value.spec.rules[0].verifyImages[0].attestors[0].entries[0].keyless.subjectRegExp = '.*'; },
    (value) => { value.spec.failurePolicy = 'Ignore'; },
    (value) => { value.spec.validationFailureAction = 'Enforce'; },
  ];
  for (const mutate of mutations) {
    const value = policy();
    mutate(value);
    const result = run(value);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /\[kyverno-readiness\] FAIL:/);
  }
});
