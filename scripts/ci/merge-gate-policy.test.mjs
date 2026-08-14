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

test('full backend and FHIR contexts are reserved for the final dispatch', () => {
  const backendJob = backend.slice(
    backend.indexOf('  lint-and-test:'),
    backend.indexOf('\n  fhir-conformance:'),
  );
  const fhirJob = backend.slice(
    backend.indexOf('  fhir-conformance:'),
    backend.indexOf('\n  semgrep:'),
  );
  assert.match(backendJob, /if: .*workflow_dispatch/);
  assert.match(fhirJob, /if: .*workflow_dispatch/);
  assert.match(canonical, /'Full Merge Gate' \|\| 'Merge Gate'/);
  // Tier selection: a manual dispatch honors the requested tier; otherwise
  // only the final `[full-ci]` marker commit forces the full matrix, and
  // every ordinary push plans automatically from the branch delta. The full
  // contexts therefore stay reserved for the final marker (or an explicit
  // dispatch), never an ordinary push.
  assert.match(
    canonical,
    /CANONICAL_TIER: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tier \|\| contains\(github\.event\.head_commit\.message, '\[full-ci\]'\) && 'full' \|\| 'auto' \}\}/,
  );
  assert.match(canonical, /needs\.plan\.outputs\.tier == 'full' && 'Full Merge Gate' \|\| 'Merge Gate'/);
});

test('Forgejo canonical CI includes the client-to-spec contracts stage', () => {
  assert.match(forgejo, /\n\s+- contracts\r?\n/);
  assert.match(forgejo, /python -m pip install --quiet semgrep/);
});
