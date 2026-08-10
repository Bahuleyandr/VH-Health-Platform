import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const canonical = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const backend = readFileSync(new URL('../../.github/workflows/ci-backend.yml', import.meta.url), 'utf8');
const forgejo = readFileSync(new URL('../../.forgejo/workflows/ci.yml', import.meta.url), 'utf8');

test('the required canonical gate cannot cancel an in-flight complete-delta run', () => {
  assert.doesNotMatch(canonical, /cancel-in-progress:\s*true/);
});

test('the canonical security stage installs Semgrep before the merge gate', () => {
  assert.match(canonical, /python -m pip install --quiet semgrep/);
});

test('required backend and FHIR contexts are emitted for every pull request', () => {
  const pullRequestBlock = backend.slice(
    backend.indexOf('  pull_request:'),
    backend.indexOf('\nconcurrency:'),
  );
  assert.doesNotMatch(pullRequestBlock, /\n\s+paths:/);

  const fhirJob = backend.slice(
    backend.indexOf('  fhir-conformance:'),
    backend.indexOf('\n  semgrep:'),
  );
  assert.doesNotMatch(fhirJob, /needs:\s*lint-and-test/);
});

test('Forgejo canonical CI includes the client-to-spec contracts stage', () => {
  assert.match(forgejo, /\n\s+- contracts\r?\n/);
  assert.match(forgejo, /python -m pip install --quiet semgrep/);
});
